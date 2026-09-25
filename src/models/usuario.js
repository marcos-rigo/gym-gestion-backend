const { pool } = require('../config/db');

async function findByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM usuarios WHERE email = $1 AND activo = true LIMIT 1',
    [email]
  );
  return rows[0] ?? null;
}

async function findAll() {
  const { rows } = await pool.query(
    'SELECT id, nombre, email, rol, activo, created_at FROM usuarios ORDER BY nombre'
  );
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(
    'SELECT id, nombre, email, rol, activo, created_at FROM usuarios WHERE id = $1 LIMIT 1',
    [id]
  );
  return rows[0] ?? null;
}

async function create({ nombre, email, password_hash, rol }) {
  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [nombre, email, password_hash, rol]
  );
  return findById(rows[0].id);
}

async function update(id, { nombre, email, rol }) {
  await pool.query(
    'UPDATE usuarios SET nombre=$1, email=$2, rol=$3 WHERE id=$4',
    [nombre, email, rol, id]
  );
  return findById(id);
}

async function toggleActivo(id) {
  const { rows } = await pool.query(
    'UPDATE usuarios SET activo = NOT activo WHERE id = $1 RETURNING id, activo',
    [id]
  );
  return rows[0] ?? null;
}

module.exports = { findByEmail, findAll, findById, create, update, toggleActivo };
