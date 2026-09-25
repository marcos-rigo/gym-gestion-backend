const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const types = require('pg').types;
types.setTypeParser(1082, (val) => val);

async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Conectado a Postgres (Supabase)');
  } catch (err) {
    console.error('❌ Error conectando a Postgres:', err.message);
    process.exit(1);
  }
}

module.exports = { pool, testConnection };
