const { pool } = require('../config/db');

async function findByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM usuarios WHERE lower(email) = lower($1) AND activo = true LIMIT 1',
    [email]
  );
  return rows[0] ?? null;
}

const SELECT_CON_ROL = `
  SELECT u.id, u.nombre, u.email, u.activo, u.created_at, u.id_rol,
         r.descripcion AS rol_descripcion, r.es_admin
  FROM usuarios u
  JOIN roles r ON r.id = u.id_rol`;

// Superadmin del sistema: visible pero inmutable desde la API (se gestiona a nivel de desarrollo/DB).
const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || 'marcos.rigo.10@gmail.com').toLowerCase();

function conProtegido(row) {
  return row ? { ...row, protegido: row.email.toLowerCase() === SUPERADMIN_EMAIL } : null;
}

async function findAll() {
  const { rows } = await pool.query(`${SELECT_CON_ROL} ORDER BY u.nombre`);
  return rows.map(conProtegido);
}

async function findById(id) {
  const { rows } = await pool.query(`${SELECT_CON_ROL} WHERE u.id = $1 LIMIT 1`, [id]);
  return conProtegido(rows[0]);
}

// ¿Existe otro usuario (activo o no) con ese email? excludeId permite ignorar al propio usuario al editar.
async function emailEnUso(email, excludeId = null) {
  const { rows } = await pool.query(
    'SELECT 1 FROM usuarios WHERE lower(email) = lower($1) AND ($2::uuid IS NULL OR id <> $2) LIMIT 1',
    [email, excludeId]
  );
  return rows.length > 0;
}

async function countAdminsActivos() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total FROM usuarios u
    JOIN roles r ON r.id = u.id_rol
    WHERE r.es_admin = true AND u.activo = true
  `);
  return rows[0].total;
}

async function create({ nombre, email, password_hash, id_rol }) {
  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, id_rol)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [nombre, email, password_hash, id_rol]
  );
  return findById(rows[0].id);
}

async function update(id, { nombre, email, id_rol }) {
  await pool.query(
    'UPDATE usuarios SET nombre=$1, email=$2, id_rol=$3 WHERE id=$4',
    [nombre, email, id_rol, id]
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

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = {
  findByEmail, findAll, findById, emailEnUso, countAdminsActivos, create, update, toggleActivo, remove,
};
