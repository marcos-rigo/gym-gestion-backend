const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Sin este handler un error en un cliente idle tumba el proceso.
pool.on('error', (err) => console.error('pg pool error:', err.message));

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

// Ejecuta fn(client) dentro de una transacción (COMMIT si resuelve, ROLLBACK si lanza).
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, testConnection, withTransaction };
