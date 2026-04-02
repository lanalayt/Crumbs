const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uhcugmrmxzgvizkjtvbg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Seed default user on startup
async function seedDefaultUser() {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('username', 'alanalana')
    .single();

  if (!data) {
    const hash = bcrypt.hashSync('crumbs2024', 10);
    await supabase.from('users').insert({
      username: 'alanalana',
      password: hash,
      display_name: 'Alan & Alana'
    });
    console.log('Default user created — username: alanalana / password: crumbs2024');
  }
}

seedDefaultUser().catch(err => console.error('Seed error:', err.message));

module.exports = supabase;
