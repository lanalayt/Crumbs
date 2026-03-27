const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const db = require('./database');
const { scrapeRecipe } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 4000;

// Image storage: persistent disk on Render, local otherwise
const imageDir = process.env.NODE_ENV === 'production' && fs.existsSync('/data')
  ? '/data/images'
  : path.join(__dirname, 'public/images');
if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(imageDir));
app.use(session({
  secret: 'crumbs-secret-recipe-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ============ AUTH ROUTES ============

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  req.session.displayName = user.display_name;
  res.json({ ok: true, displayName: user.display_name });
});

app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)').run(
    username, hash, displayName || username
  );
  req.session.userId = result.lastInsertRowid;
  req.session.displayName = displayName || username;
  res.json({ ok: true, displayName: displayName || username });
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

app.get('/api/cuisines', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT name FROM custom_cuisines ORDER BY name COLLATE NOCASE ASC').all();
  res.json(rows.map(r => r.name));
});

app.post('/api/cuisines', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const val = name.trim();
  const existing = db.prepare('SELECT id FROM custom_cuisines WHERE name = ?').get(val);
  if (!existing) {
    db.prepare('INSERT INTO custom_cuisines (name) VALUES (?)').run(val);
  }
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

  // Download image locally if we have a URL
  let localImage = null;
  if (imageUrl) {
    try {
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const ext = (response.headers['content-type'] || 'image/jpeg').includes('png') ? '.png' : '.jpg';
      const filename = `recipe_${Date.now()}${ext}`;
      fs.writeFileSync(path.join(imageDir, filename), response.data);
      localImage = filename;
    } catch (e) {
      console.error('Image download failed:', e.message);
    }
  }

  const result = db.prepare(`
    INSERT INTO recipes (user_id, title, source_url, image_url, local_image, meal_type, cuisine_type, ingredients, instructions, tips, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.userId,
    title,
    sourceUrl || null,
    imageUrl || null,
    localImage,
    mealType || null,
    cuisineType || null,
    JSON.stringify(ingredients || []),
    JSON.stringify(instructions || []),
    tips || '',
    JSON.stringify(tags || [])
  );

  res.json({ ok: true, id: result.lastInsertRowid });
});

// Get all recipes for the logged-in user
app.get('/api/recipes', requireAuth, (req, res) => {
  const recipes = db.prepare(`
    SELECT id, title, local_image, image_url, meal_type, cuisine_type, tags, created_at
    FROM recipes WHERE user_id = ?
    ORDER BY title COLLATE NOCASE ASC
  `).all(req.session.userId);
  res.json(recipes);
});

// Get single recipe
app.get('/api/recipes/:id', requireAuth, (req, res) => {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND user_id = ?').get(
    req.params.id, req.session.userId
  );
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  recipe.ingredients = JSON.parse(recipe.ingredients || '[]');
  recipe.instructions = JSON.parse(recipe.instructions || '[]');
  recipe.tags = JSON.parse(recipe.tags || '[]');
  res.json(recipe);
});

// Update recipe
app.put('/api/recipes/:id', requireAuth, (req, res) => {
  const { title, mealType, cuisineType, ingredients, instructions, tips, tags } = req.body;
  const existing = db.prepare('SELECT id FROM recipes WHERE id = ? AND user_id = ?').get(
    req.params.id, req.session.userId
  );
  if (!existing) return res.status(404).json({ error: 'Recipe not found' });

  db.prepare(`
    UPDATE recipes SET title = ?, meal_type = ?, cuisine_type = ?, ingredients = ?, instructions = ?, tips = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    title, mealType || null, cuisineType || null,
    JSON.stringify(ingredients || []),
    JSON.stringify(instructions || []),
    tips || '',
    JSON.stringify(tags || []),
    req.params.id, req.session.userId
  );

  res.json({ ok: true });
});

// Delete recipe
app.delete('/api/recipes/:id', requireAuth, (req, res) => {
  const recipe = db.prepare('SELECT local_image FROM recipes WHERE id = ? AND user_id = ?').get(
    req.params.id, req.session.userId
  );
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  // Clean up local image
  if (recipe.local_image) {
    const imgPath = path.join(imageDir, recipe.local_image);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  db.prepare('DELETE FROM recipes WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

// ============ CATCH-ALL: serve index.html ============
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🍞 Crumbs is running at http://localhost:${PORT}`);
});
