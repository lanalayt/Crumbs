const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const supabase = require('./database');
const { scrapeRecipe } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Trust proxy on Render (needed for secure cookies behind HTTPS)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'crumbs-secret-recipe-key',
  resave: false,
  saveUninitialized: false,
  proxy: process.env.NODE_ENV === 'production',
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ============ AUTH ROUTES ============

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  req.session.displayName = user.display_name;
  res.json({ ok: true, displayName: user.display_name });
});

app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('username', username)
    .single();

  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ username, password: hash, display_name: displayName || username })
    .select('id, display_name')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  req.session.userId = newUser.id;
  req.session.displayName = newUser.display_name;
  res.json({ ok: true, displayName: newUser.display_name });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ loggedIn: true, displayName: req.session.displayName });
  } else {
    res.json({ loggedIn: false });
  }
});

// ============ CUSTOM CUISINES ============

app.get('/api/cuisines', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('custom_cuisines')
    .select('name')
    .order('name', { ascending: true });
  res.json((data || []).map(r => r.name));
});

app.post('/api/cuisines', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const val = name.trim();
  await supabase.from('custom_cuisines').upsert({ name: val }, { onConflict: 'name' });
  res.json({ ok: true });
});

// ============ RECIPE ROUTES ============

// Scrape a recipe from URL
app.post('/api/scrape', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const recipe = await scrapeRecipe(url);
    res.json(recipe);
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: 'Failed to scrape recipe. The site may be blocking requests or the URL may be invalid.' });
  }
});

// Save a recipe
app.post('/api/recipes', requireAuth, async (req, res) => {
  const { title, sourceUrl, imageUrl, mealType, cuisineType, ingredients, instructions, tips, tags } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const { data, error } = await supabase
    .from('recipes')
    .insert({
      user_id: req.session.userId,
      title,
      source_url: sourceUrl || null,
      image_url: imageUrl || null,
      local_image: null,
      meal_type: mealType || null,
      cuisine_type: cuisineType || null,
      ingredients: ingredients || [],
      instructions: instructions || [],
      tips: tips || '',
      tags: tags || [],
    })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, id: data.id });
});

// Get all recipes for the logged-in user
app.get('/api/recipes', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('recipes')
    .select('id, title, image_url, meal_type, cuisine_type, tags, created_at')
    .eq('user_id', req.session.userId)
    .order('title', { ascending: true });
  res.json(data || []);
});

// Get single recipe
app.get('/api/recipes/:id', requireAuth, async (req, res) => {
  const { data: recipe } = await supabase
    .from('recipes')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.session.userId)
    .single();

  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  res.json(recipe);
});

// Update recipe
app.put('/api/recipes/:id', requireAuth, async (req, res) => {
  const { title, mealType, cuisineType, ingredients, instructions, tips, tags } = req.body;

  const { data: existing } = await supabase
    .from('recipes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.session.userId)
    .single();

  if (!existing) return res.status(404).json({ error: 'Recipe not found' });

  const { error } = await supabase
    .from('recipes')
    .update({
      title,
      meal_type: mealType || null,
      cuisine_type: cuisineType || null,
      ingredients: ingredients || [],
      instructions: instructions || [],
      tips: tips || '',
      tags: tags || [],
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .eq('user_id', req.session.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Delete recipe
app.delete('/api/recipes/:id', requireAuth, async (req, res) => {
  const { data: recipe } = await supabase
    .from('recipes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.session.userId)
    .single();

  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  await supabase
    .from('recipes')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.session.userId);

  res.json({ ok: true });
});

// ============ CATCH-ALL: serve index.html ============
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🍞 Crumbs is running at http://localhost:${PORT}`);
});
