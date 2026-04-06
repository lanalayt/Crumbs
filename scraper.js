const axios = require('axios');
const cheerio = require('cheerio');

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Scrape a recipe from a URL.
 * Tries axios first (fast), falls back to puppeteer (full browser) if blocked.
 */
async function scrapeRecipe(url) {
  let html;

  // Try multiple HTTP approaches before falling back to Puppeteer
  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  ];

  for (const ua of userAgents) {
    if (html) break;
    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache',
        },
        timeout: 12000,
        maxRedirects: 5,
      });
      html = data;
    } catch (err) {
      console.log(`Axios failed with UA [${ua.slice(0, 30)}...]:`, err.message);
    }
  }

  // Fallback: use Puppeteer (only locally — too heavy for Render free tier)
  if (!html && !isProduction) {
    let browser;
    try {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();
      await page.setUserAgent(userAgents[0]);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      html = await page.content();
    } catch (e) {
      console.log('Puppeteer fallback failed:', e.message);
    } finally {
      if (browser) await browser.close();
    }
  }

  if (!html) {
    throw new Error('Could not fetch the page');
  }

  return parseRecipeHtml(html);
}

/**
 * Parse recipe data from HTML string
 */
function parseRecipeHtml(html) {
  const $ = cheerio.load(html);
  let recipe = { title: '', image: '', ingredients: [], instructions: [], tips: '' };

  // --- Try JSON-LD structured data (Schema.org Recipe) ---
  const jsonLdScripts = $('script[type="application/ld+json"]');
  let recipeSchema = null;

  jsonLdScripts.each((_, el) => {
    try {
      let parsed = JSON.parse($(el).html());
      recipeSchema = recipeSchema || findRecipeInSchema(parsed);
    } catch (e) { /* ignore parse errors */ }
  });

  if (recipeSchema) {
    recipe.title = recipeSchema.name || '';

    // Image
    if (recipeSchema.image) {
      if (typeof recipeSchema.image === 'string') {
        recipe.image = recipeSchema.image;
      } else if (Array.isArray(recipeSchema.image)) {
        recipe.image = typeof recipeSchema.image[0] === 'string' ? recipeSchema.image[0] : (recipeSchema.image[0]?.url || '');
      } else if (recipeSchema.image.url) {
        recipe.image = recipeSchema.image.url;
      }
    }

    // Ingredients
    if (recipeSchema.recipeIngredient) {
      recipe.ingredients = recipeSchema.recipeIngredient.map(i => stripHtml(i));
    }

    // Instructions
    if (recipeSchema.recipeInstructions) {
      recipe.instructions = parseInstructions(recipeSchema.recipeInstructions);
    }

    // Tips from description
    if (recipeSchema.description) {
      recipe.tips = stripHtml(recipeSchema.description);
    }
  }

  // --- Fallback: scrape from page content ---
  if (!recipe.title) {
    recipe.title = $('h1').first().text().trim() ||
                   $('meta[property="og:title"]').attr('content') ||
                   $('title').text().trim();
  }

  if (!recipe.image) {
    recipe.image = $('meta[property="og:image"]').attr('content') ||
                   $('article img, .recipe img, .hero img, main img').first().attr('src') || '';
  }

  if (recipe.ingredients.length === 0) {
    const selectors = [
      '.wprm-recipe-ingredient',
      '.recipe-ingredients li',
      '.ingredients li',
      '[class*="ingredient"] li',
      '.tasty-recipe-ingredients li',
      '.ingredient-list li',
    ];
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const text = $(el).text().trim();
        if (text) recipe.ingredients.push(text);
      });
      if (recipe.ingredients.length > 0) break;
    }
  }

  if (recipe.instructions.length === 0) {
    const selectors = [
      '.wprm-recipe-instruction',
      '.recipe-instructions li',
      '.instructions li',
      '.directions li',
      '[class*="instruction"] li',
      '.tasty-recipe-instructions li',
      '.recipe-directions li',
      '.direction-list li',
    ];
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const text = $(el).text().trim();
        if (text) recipe.instructions.push(text);
      });
      if (recipe.instructions.length > 0) break;
    }
  }

  // --- Last resort: find lists near "Ingredients" / "Instructions" headings ---
  if (recipe.ingredients.length === 0 || recipe.instructions.length === 0) {
    $('h2, h3, h4, strong, b, p').each((_, heading) => {
      const headingText = $(heading).text().trim().toLowerCase();

      if (recipe.ingredients.length === 0 && headingText.includes('ingredient')) {
        // Look for the next <ul> or <ol> after this heading
        const list = findNextList($, heading);
        if (list.length > 0) recipe.ingredients = list;
      }

      if (recipe.instructions.length === 0 && (headingText.includes('instruction') || headingText.includes('direction') || headingText.includes('how to') || headingText.includes('steps'))) {
        const list = findNextList($, heading);
        if (list.length > 0) recipe.instructions = list;
      }
    });
  }

  // Clean up
  recipe.title = recipe.title.replace(/\s+/g, ' ').trim();
  recipe.ingredients = recipe.ingredients.filter(i => i.length > 0);
  recipe.instructions = recipe.instructions.filter(i => i.length > 0);

  return recipe;
}

/**
 * Recursively find a Recipe object in JSON-LD data
 */
function findRecipeInSchema(data) {
  if (!data) return null;

  // Direct Recipe type
  if (data['@type'] === 'Recipe') return data;
  if (Array.isArray(data['@type']) && data['@type'].includes('Recipe')) return data;

  // Array of items
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeInSchema(item);
      if (found) return found;
    }
  }

  // @graph container
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      const found = findRecipeInSchema(item);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Starting from a heading element, walk forward through siblings
 * (and parent siblings) to find the next <ul> or <ol> and return its items.
 */
function findNextList($, heading) {
  const items = [];

  // Try next siblings of the heading itself
  let next = $(heading).next();
  for (let i = 0; i < 5 && next.length; i++) {
    if (next.is('ul, ol')) {
      next.find('li').each((_, li) => {
        const text = $(li).text().trim();
        if (text) items.push(text);
      });
      return items;
    }
    // If the sibling contains a list, grab from inside it
    const nested = next.find('ul, ol').first();
    if (nested.length) {
      nested.find('li').each((_, li) => {
        const text = $(li).text().trim();
        if (text) items.push(text);
      });
      return items;
    }
    next = next.next();
  }

  // Try next siblings of the heading's parent
  let parent = $(heading).parent();
  next = parent.next();
  for (let i = 0; i < 5 && next.length; i++) {
    if (next.is('ul, ol')) {
      next.find('li').each((_, li) => {
        const text = $(li).text().trim();
        if (text) items.push(text);
      });
      return items;
    }
    const nested = next.find('ul, ol').first();
    if (nested.length) {
      nested.find('li').each((_, li) => {
        const text = $(li).text().trim();
        if (text) items.push(text);
      });
      return items;
    }
    next = next.next();
  }

  return items;
}

function parseInstructions(inst) {
  if (!inst) return [];
  if (typeof inst === 'string') {
    return inst.split(/\n+/).map(s => stripHtml(s).trim()).filter(Boolean);
  }
  if (Array.isArray(inst)) {
    const result = [];
    for (const item of inst) {
      if (typeof item === 'string') {
        result.push(stripHtml(item).trim());
      } else if (item.text) {
        result.push(stripHtml(item.text).trim());
      } else if (item['@type'] === 'HowToSection' && item.itemListElement) {
        for (const sub of item.itemListElement) {
          result.push(stripHtml(sub.text || sub.name || '').trim());
        }
      } else if (item.name) {
        result.push(stripHtml(item.name).trim());
      }
    }
    return result;
  }
  return [];
}

function stripHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

module.exports = { scrapeRecipe };
