const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

// Use persistent disk on Render, local directory otherwise
const dataDir = process.env.NODE_ENV === 'production' && fs.existsSync('/data') ? '/data' : __dirname;
const db = new Database(path.join(dataDir, 'crumbs.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    source_url TEXT,
    image_url TEXT,
    local_image TEXT,
    meal_type TEXT,
    cuisine_type TEXT,
    ingredients TEXT,
    instructions TEXT,
    tips TEXT,
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS custom_cuisines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );
`);

// Seed default user (Alan & Alana)
const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get('alanalana');
if (!existingUser) {
  const hash = bcrypt.hashSync('crumbs2024', 10);
  db.prepare('INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)').run(
    'alanalana',
    hash,
    'Alan & Alana'
  );
  console.log('Default user created — username: alanalana / password: crumbs2024');
}

// Migration: add tags column if it doesn't exist
try {
  db.prepare("SELECT tags FROM recipes LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE recipes ADD COLUMN tags TEXT DEFAULT '[]'");
  console.log('Migrated: added tags column to recipes');
}

module.exports = db;
