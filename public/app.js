// ============================================
// CRUMBS — Frontend Application
// ============================================

let currentRecipes = [];
let currentScrapedData = null;
let currentViewId = null;
let isEditing = false;
let previewTags = [];
let editTags = [];

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.loggedIn) {
    showApp(data.displayName);
  } else {
    showLogin();
  }

  // Auth handlers
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('register-form').addEventListener('submit', handleRegister);
  document.getElementById('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-form').style.display = 'none';
    document.querySelector('.switch-auth').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
    document.getElementById('show-login-link').style.display = 'block';
    document.getElementById('auth-error').textContent = '';
  });
  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('show-login-link').style.display = 'none';
    document.getElementById('login-form').style.display = 'block';
    document.querySelector('.switch-auth').style.display = 'block';
    document.getElementById('auth-error').textContent = '';
  });

  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // Scrape
  document.getElementById('scrape-btn').addEventListener('click', handleScrape);
  document.getElementById('url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleScrape();
  });

  // Save scraped recipe
  document.getElementById('save-recipe-btn').addEventListener('click', handleSaveRecipe);

  // Filters & search
  document.getElementById('search-input').addEventListener('input', renderFilteredRecipes);
  document.getElementById('filter-meal').addEventListener('change', renderFilteredRecipes);
  document.getElementById('filter-cuisine').addEventListener('change', renderFilteredRecipes);
  document.getElementById('sort-order').addEventListener('change', renderFilteredRecipes);

  // "Other" cuisine — prompt for custom value
  document.getElementById('preview-cuisine').addEventListener('change', handleOtherCuisine);

  // Tag input in preview modal
  setupTagInput('preview-tag-input', 'preview-tag-pills', () => previewTags, (t) => { previewTags = t; });

  // Recipe modal buttons
  document.getElementById('edit-recipe-btn').addEventListener('click', enterEditMode);
  document.getElementById('cancel-edit-btn').addEventListener('click', exitEditMode);
  document.getElementById('update-recipe-btn').addEventListener('click', handleUpdateRecipe);
  document.getElementById('delete-recipe-btn').addEventListener('click', handleDeleteRecipe);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Close modals on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach(m => {
        if (m.style.display !== 'none') closeModal(m.id);
      });
    }
  });
});

// ===== AUTH =====
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (res.ok) {
    showApp(data.displayName);
  } else {
    document.getElementById('auth-error').textContent = data.error;
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const displayName = document.getElementById('reg-display').value.trim();
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, displayName })
  });
  const data = await res.json();
  if (res.ok) {
    showApp(data.displayName);
  } else {
    document.getElementById('auth-error').textContent = data.error;
  }
}

async function handleLogout() {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
}

function showApp(displayName) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('user-greeting').textContent = `Hey, ${displayName}!`;
  loadCustomCuisines();
  loadRecipes();
}

async function loadCustomCuisines() {
  try {
    const res = await fetch('/api/cuisines');
    const customs = await res.json();
    customs.forEach(name => {
      if (!cuisineOptions.includes(name)) {
        // Insert before "Other"
        const otherIdx = cuisineOptions.indexOf('Other');
        cuisineOptions.splice(otherIdx, 0, name);
      }
    });
    // Also add to all cuisine dropdowns currently in the DOM
    addCuisinesToSelect(document.getElementById('filter-cuisine'), customs);
    addCuisinesToSelect(document.getElementById('preview-cuisine'), customs);
  } catch (e) { /* ignore */ }
}

function addCuisinesToSelect(select, cuisines) {
  if (!select) return;
  const existing = new Set([...select.options].map(o => o.value));
  cuisines.forEach(name => {
    if (!existing.has(name)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      const otherOpt = select.querySelector('option[value="Other"]');
      if (otherOpt) {
        select.insertBefore(opt, otherOpt);
      } else {
        select.appendChild(opt);
      }
    }
  });
}

// ===== RECIPES =====
async function loadRecipes() {
  const res = await fetch('/api/recipes');
  currentRecipes = await res.json();
  renderFilteredRecipes();
}

function renderFilteredRecipes() {
  const search = document.getElementById('search-input').value.toLowerCase().trim();
  const meal = document.getElementById('filter-meal').value;
  const cuisine = document.getElementById('filter-cuisine').value;
  const sort = document.getElementById('sort-order').value;

  let filtered = currentRecipes.filter(r => {
    if (search) {
      const titleMatch = r.title.toLowerCase().includes(search);
      const recipeTags = parseTags(r.tags);
      const tagMatch = recipeTags.some(t => t.toLowerCase().includes(search));
      if (!titleMatch && !tagMatch) return false;
    }
    if (meal && r.meal_type !== meal) return false;
    if (cuisine && r.cuisine_type !== cuisine) return false;
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    switch (sort) {
      case 'alpha-asc': return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      case 'alpha-desc': return b.title.localeCompare(a.title, undefined, { sensitivity: 'base' });
      case 'newest': return new Date(b.created_at) - new Date(a.created_at);
      case 'oldest': return new Date(a.created_at) - new Date(b.created_at);
      default: return 0;
    }
  });

  const grid = document.getElementById('recipe-grid');
  const empty = document.getElementById('empty-state');

  if (filtered.length === 0 && currentRecipes.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  if (filtered.length === 0) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#888;padding:3rem 0;">No recipes match your filters.</p>';
    return;
  }

  grid.innerHTML = filtered.map(r => {
    const imgSrc = r.local_image ? `/images/${r.local_image}` : r.image_url;
    const imgHtml = imgSrc
      ? `<img class="card-image" src="${escapeAttr(imgSrc)}" alt="${escapeAttr(r.title)}" onerror="this.outerHTML='<div class=card-image-placeholder>🍳</div>'" />`
      : `<div class="card-image-placeholder">🍳</div>`;

    const recipeTags = parseTags(r.tags);
    const customTagsHtml = recipeTags.map(t => `<span class="tag tag-custom">${escapeHtml(t)}</span>`).join('');

    return `
      <div class="recipe-card" onclick="viewRecipe(${r.id})">
        ${imgHtml}
        <div class="card-body">
          <div class="card-title">${escapeHtml(r.title)}</div>
          <div class="card-tags">
            ${r.meal_type ? `<span class="tag tag-meal">${escapeHtml(r.meal_type)}</span>` : ''}
            ${r.cuisine_type ? `<span class="tag tag-cuisine">${escapeHtml(r.cuisine_type)}</span>` : ''}
            ${customTagsHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ===== SCRAPE =====
async function handleScrape() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) return;

  const btn = document.getElementById('scrape-btn');
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loading').style.display = 'inline';
  btn.disabled = true;

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentScrapedData = { ...data, sourceUrl: url };
    showPreviewModal(data);
  } catch (err) {
    toast(err.message || 'Failed to scrape recipe', 'error');
  } finally {
    btn.querySelector('.btn-text').style.display = 'inline';
    btn.querySelector('.btn-loading').style.display = 'none';
    btn.disabled = false;
  }
}

function showPreviewModal(data) {
  const imgEl = document.getElementById('preview-image');
  if (data.image) {
    imgEl.src = data.image;
    imgEl.parentElement.style.display = 'block';
  } else {
    imgEl.parentElement.style.display = 'none';
  }
  document.getElementById('preview-title').value = data.title || '';
  document.getElementById('preview-meal').value = '';
  document.getElementById('preview-cuisine').value = '';
  document.getElementById('preview-ingredients').value = (data.ingredients || []).join('\n');
  document.getElementById('preview-instructions').value = (data.instructions || []).join('\n');
  document.getElementById('preview-tips').value = data.tips || '';

  // Reset tags
  previewTags = [];
  renderTagPills('preview-tag-pills', previewTags, () => previewTags, (t) => { previewTags = t; });

  document.getElementById('preview-modal').style.display = 'flex';
}

async function handleSaveRecipe() {
  const payload = {
    title: document.getElementById('preview-title').value.trim(),
    sourceUrl: currentScrapedData?.sourceUrl || '',
    imageUrl: currentScrapedData?.image || '',
    mealType: document.getElementById('preview-meal').value,
    cuisineType: document.getElementById('preview-cuisine').value,
    ingredients: document.getElementById('preview-ingredients').value.split('\n').filter(l => l.trim()),
    instructions: document.getElementById('preview-instructions').value.split('\n').filter(l => l.trim()),
    tips: document.getElementById('preview-tips').value.trim(),
    tags: previewTags,
  };

  if (!payload.title) {
    toast('Please enter a recipe title', 'error');
    return;
  }

  try {
    const res = await fetch('/api/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeModal('preview-modal');
    document.getElementById('url-input').value = '';
    toast('Recipe saved!', 'success');
    loadRecipes();
  } catch (err) {
    toast(err.message || 'Failed to save recipe', 'error');
  }
}

// ===== VIEW / EDIT RECIPE =====
async function viewRecipe(id) {
  currentViewId = id;
  isEditing = false;

  const res = await fetch(`/api/recipes/${id}`);
  const recipe = await res.json();
  if (!res.ok) return toast(recipe.error, 'error');

  document.getElementById('recipe-modal-title').textContent = recipe.title;

  const imgSrc = recipe.local_image ? `/images/${recipe.local_image}` : recipe.image_url;

  let html = '';
  if (imgSrc) {
    html += `<img class="view-recipe-image" src="${escapeAttr(imgSrc)}" alt="${escapeAttr(recipe.title)}" onerror="this.style.display='none'" />`;
  }

  html += '<div class="view-recipe-tags">';
  if (recipe.meal_type) html += `<span class="tag tag-meal">${escapeHtml(recipe.meal_type)}</span>`;
  if (recipe.cuisine_type) html += `<span class="tag tag-cuisine">${escapeHtml(recipe.cuisine_type)}</span>`;
  const viewTags = recipe.tags || [];
  viewTags.forEach(t => { html += `<span class="tag tag-custom">${escapeHtml(t)}</span>`; });
  html += '</div>';

  if (recipe.source_url) {
    html += `<div class="view-recipe-source">Source: <a href="${escapeAttr(recipe.source_url)}" target="_blank" rel="noopener">${escapeHtml(recipe.source_url)}</a></div>`;
  }

  // Ingredients
  html += '<div class="section-title">Ingredients</div>';
  html += '<ul class="ingredients-list" id="view-ingredients">';
  recipe.ingredients.forEach(i => html += `<li>${escapeHtml(i)}</li>`);
  html += '</ul>';

  // Instructions
  html += '<div class="section-title">Instructions</div>';
  html += '<ol class="instructions-list" id="view-instructions">';
  recipe.instructions.forEach(s => html += `<li>${escapeHtml(s)}</li>`);
  html += '</ol>';

  // Tips
  if (recipe.tips) {
    html += '<div class="section-title">Tips & Hints</div>';
    html += `<div class="tips-box" id="view-tips">${escapeHtml(recipe.tips)}</div>`;
  }

  // Hidden data for edit mode
  html += `<input type="hidden" id="view-data"
    data-title="${escapeAttr(recipe.title)}"
    data-meal="${escapeAttr(recipe.meal_type || '')}"
    data-cuisine="${escapeAttr(recipe.cuisine_type || '')}"
    data-ingredients="${escapeAttr(recipe.ingredients.join('\n'))}"
    data-instructions="${escapeAttr(recipe.instructions.join('\n'))}"
    data-tips="${escapeAttr(recipe.tips || '')}"
    data-tags="${escapeAttr(JSON.stringify(recipe.tags || []))}"
  />`;

  document.getElementById('recipe-modal-body').innerHTML = html;

  // Show view buttons, hide edit buttons
  document.getElementById('edit-recipe-btn').style.display = '';
  document.getElementById('delete-recipe-btn').style.display = '';
  document.getElementById('update-recipe-btn').style.display = 'none';
  document.getElementById('cancel-edit-btn').style.display = 'none';

  document.getElementById('recipe-modal').style.display = 'flex';
}

function enterEditMode() {
  isEditing = true;
  const d = document.getElementById('view-data').dataset;

  const body = document.getElementById('recipe-modal-body');
  let html = '';

  // Keep image if present
  const img = body.querySelector('.view-recipe-image');
  if (img) html += img.outerHTML;

  html += '<label>Title</label>';
  html += `<input type="text" class="edit-title" value="${escapeAttr(d.title)}" />`;

  html += '<div class="two-col">';
  html += '<div><label>Meal Type</label>' + buildSelect('edit-meal', mealOptions, d.meal) + '</div>';
  html += '<div><label>Cuisine</label>' + buildSelect('edit-cuisine', cuisineOptions, d.cuisine) + '</div>';
  html += '</div>';

  html += '<label>Tags</label>';
  html += '<div class="tag-input-wrap" id="edit-tag-input-wrap">';
  html += '<div class="tag-pills" id="edit-tag-pills"></div>';
  html += '<input type="text" id="edit-tag-input" placeholder="Type a tag and press Enter..." />';
  html += '</div>';

  html += '<label>Ingredients <small style="color:#aaa">(one per line)</small></label>';
  html += `<textarea class="edit-ingredients" rows="8">${escapeHtml(d.ingredients)}</textarea>`;

  html += '<label>Instructions <small style="color:#aaa">(one per line)</small></label>';
  html += `<textarea class="edit-instructions" rows="8">${escapeHtml(d.instructions)}</textarea>`;

  html += '<label>Tips & Hints</label>';
  html += `<textarea class="edit-tips" rows="3">${escapeHtml(d.tips)}</textarea>`;

  body.innerHTML = html;

  // Initialize edit tags
  try { editTags = JSON.parse(d.tags || '[]'); } catch (e) { editTags = []; }
  renderTagPills('edit-tag-pills', editTags, () => editTags, (t) => { editTags = t; });
  setupTagInput('edit-tag-input', 'edit-tag-pills', () => editTags, (t) => { editTags = t; });

  // Attach "Other" cuisine handler in edit mode
  const editCuisineEl = body.querySelector('.edit-cuisine');
  if (editCuisineEl) editCuisineEl.addEventListener('change', handleOtherCuisine);

  document.getElementById('edit-recipe-btn').style.display = 'none';
  document.getElementById('delete-recipe-btn').style.display = 'none';
  document.getElementById('update-recipe-btn').style.display = '';
  document.getElementById('cancel-edit-btn').style.display = '';
}

function exitEditMode() {
  viewRecipe(currentViewId);
}

async function handleUpdateRecipe() {
  const payload = {
    title: document.querySelector('.edit-title').value.trim(),
    mealType: document.querySelector('.edit-meal').value,
    cuisineType: document.querySelector('.edit-cuisine').value,
    ingredients: document.querySelector('.edit-ingredients').value.split('\n').filter(l => l.trim()),
    instructions: document.querySelector('.edit-instructions').value.split('\n').filter(l => l.trim()),
    tips: document.querySelector('.edit-tips').value.trim(),
    tags: editTags,
  };

  if (!payload.title) return toast('Title is required', 'error');

  try {
    const res = await fetch(`/api/recipes/${currentViewId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error((await res.json()).error);

    toast('Recipe updated!', 'success');
    loadRecipes();
    viewRecipe(currentViewId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleDeleteRecipe() {
  if (!confirm('Delete this recipe? This cannot be undone.')) return;

  try {
    const res = await fetch(`/api/recipes/${currentViewId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);

    closeModal('recipe-modal');
    toast('Recipe deleted', 'success');
    loadRecipes();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ===== "OTHER" CUISINE HANDLER =====
function handleOtherCuisine(e) {
  const select = e.target;
  if (select.value !== 'Other') return;

  const custom = prompt('Enter a cuisine type (or press Cancel to keep "Other"):');
  if (custom && custom.trim()) {
    const val = custom.trim();

    // Save to database permanently
    fetch('/api/cuisines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: val })
    });

    // Add to the global options list
    if (!cuisineOptions.includes(val)) {
      const otherIdx = cuisineOptions.indexOf('Other');
      cuisineOptions.splice(otherIdx, 0, val);
    }

    // Add to ALL cuisine selects in the DOM
    document.querySelectorAll('#filter-cuisine, #preview-cuisine, .edit-cuisine').forEach(sel => {
      let found = false;
      for (const opt of sel.options) {
        if (opt.value === val) { found = true; break; }
      }
      if (!found) {
        const newOpt = document.createElement('option');
        newOpt.value = val;
        newOpt.textContent = val;
        const otherOpt = sel.querySelector('option[value="Other"]');
        if (otherOpt) sel.insertBefore(newOpt, otherOpt);
        else sel.appendChild(newOpt);
      }
    });

    select.value = val;
  }
  // If they cancelled or left blank, it stays as "Other"
}

// ===== HELPERS =====
const mealOptions = ['', 'Breakfast', 'Lunch', 'Dinner', 'Appetizers & Snacks', 'Desserts', 'Soups & Salads', 'Side Dishes', 'Drinks & Smoothies'];
const cuisineOptions = ['', 'American', 'Italian', 'Mexican', 'Chinese', 'Japanese', 'Indian', 'Thai', 'Mediterranean', 'French', 'Korean', 'Filipino', 'Other'];

function buildSelect(className, options, selected) {
  const labels = { '': 'Select...' };
  // If the saved value is custom and not in the options list, add it before "Other"
  let opts = [...options];
  if (selected && !opts.includes(selected)) {
    const otherIdx = opts.indexOf('Other');
    if (otherIdx !== -1) {
      opts.splice(otherIdx, 0, selected);
    } else {
      opts.push(selected);
    }
  }
  return `<select class="${className}">${opts.map(o =>
    `<option value="${o}" ${o === selected ? 'selected' : ''}>${labels[o] || o}</option>`
  ).join('')}</select>`;
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
  isEditing = false;
}

function toast(msg, type = '') {
  // Remove existing toasts
  document.querySelectorAll('.toast').forEach(t => t.remove());

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== TAG HELPERS =====
function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    try { return JSON.parse(tags); } catch (e) { return []; }
  }
  return [];
}

function setupTagInput(inputId, pillsContainerId, getTagsFn, setTagsFn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = input.value.replace(/,/g, '').trim().toLowerCase();
      if (val && !getTagsFn().includes(val)) {
        const tags = [...getTagsFn(), val];
        setTagsFn(tags);
        renderTagPills(pillsContainerId, tags, getTagsFn, setTagsFn);
      }
      input.value = '';
    }
  });
}

function renderTagPills(containerId, tags, getTagsFn, setTagsFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = tags.map((t, i) =>
    `<span class="tag-pill">${escapeHtml(t)}<button type="button" class="tag-pill-remove" data-index="${i}">&times;</button></span>`
  ).join('');
  container.querySelectorAll('.tag-pill-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      const updated = getTagsFn().filter((_, j) => j !== idx);
      setTagsFn(updated);
      renderTagPills(containerId, updated, getTagsFn, setTagsFn);
    });
  });
}
