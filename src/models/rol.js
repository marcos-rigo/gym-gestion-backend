const { pool } = require('../config/db');

async function findAll() {
  const { rows } = await pool.query(`
    SELECT r.id, r.descripcion, r.es_admin, r.created_at,
      COUNT(DISTINCT u.id) FILTER (WHERE u.activo) AS user_count,
      COALESCE(array_agg(DISTINCT p.descripcion) FILTER (WHERE p.descripcion IS NOT NULL), '{}') AS permissions
    FROM roles r
    LEFT JOIN usuarios u ON u.id_rol = r.id
    LEFT JOIN linea_permiso lp ON lp.id_rol = r.id
    LEFT JOIN permisos p ON p.id = lp.id_permiso
    GROUP BY r.id, r.descripcion, r.es_admin, r.created_at
    ORDER BY r.descripcion
  `);
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(`
    SELECT r.id, r.descripcion, r.es_admin, r.created_at,
      COUNT(DISTINCT u.id) FILTER (WHERE u.activo) AS user_count,
      COALESCE(array_agg(DISTINCT p.descripcion) FILTER (WHERE p.descripcion IS NOT NULL), '{}') AS permissions
    FROM roles r
    LEFT JOIN usuarios u ON u.id_rol = r.id
    LEFT JOIN linea_permiso lp ON lp.id_rol = r.id
    LEFT JOIN permisos p ON p.id = lp.id_permiso
    WHERE r.id = $1
    GROUP BY r.id, r.descripcion, r.es_admin, r.created_at
  `, [id]);
  return rows[0] ?? null;
}

async function create({ descripcion, permissions = [] }) {
  const { rows } = await pool.query(
    'INSERT INTO roles (descripcion) VALUES ($1) RETURNING id', [descripcion]
  );
  if (permissions.length > 0) await syncPermissions(rows[0].id, permissions);
  return findById(rows[0].id);
}

async function update(id, { descripcion, permissions }) {
  if (descripcion !== undefined) {
    await pool.query('UPDATE roles SET descripcion = $1 WHERE id = $2', [descripcion, id]);
  }
  if (permissions !== undefined) await syncPermissions(id, permissions);
  return findById(id);
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM roles WHERE id = $1', [id]);
  return rowCount > 0;
}

async function syncPermissions(rolId, permissionDescriptions) {
  await pool.query('DELETE FROM linea_permiso WHERE id_rol = $1', [rolId]);
  if (permissionDescriptions.length === 0) return;
  const { rows: perms } = await pool.query(
    'SELECT id FROM permisos WHERE descripcion = ANY($1)', [permissionDescriptions]
  );
  for (const p of perms) {
    await pool.query('INSERT INTO linea_permiso (id_rol, id_permiso) VALUES ($1, $2)', [rolId, p.id]);
  }
}

async function findAllPermisos() {
  const { rows } = await pool.query('SELECT descripcion FROM permisos ORDER BY descripcion');
  return rows.map(r => r.descripcion);
}

module.exports = { findAll, findById, create, update, remove, findAllPermisos };
