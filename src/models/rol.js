const { pool, withTransaction } = require('../config/db');

// user_count: usuarios activos; assigned_count: todos los asignados (activos o no), que es lo que bloquea el borrado.
const SELECT_ROL = `
  SELECT r.id, r.descripcion, r.es_admin, r.created_at,
    (SELECT COUNT(*) FROM usuarios u WHERE u.id_rol = r.id AND u.activo)::int AS user_count,
    (SELECT COUNT(*) FROM usuarios u WHERE u.id_rol = r.id)::int AS assigned_count,
    COALESCE((
      SELECT array_agg(p.descripcion ORDER BY p.descripcion)
      FROM linea_permiso lp JOIN permisos p ON p.id = lp.id_permiso
      WHERE lp.id_rol = r.id
    ), '{}') AS permissions
  FROM roles r`;

async function findAll() {
  const { rows } = await pool.query(`${SELECT_ROL} ORDER BY r.descripcion`);
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(`${SELECT_ROL} WHERE r.id = $1`, [id]);
  return rows[0] ?? null;
}

// Versión liviana para validar existencia / es_admin sin armar permisos.
async function findBasicById(id) {
  const { rows } = await pool.query('SELECT id, es_admin FROM roles WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function syncPermissions(client, rolId, permissionDescriptions) {
  await client.query('DELETE FROM linea_permiso WHERE id_rol = $1', [rolId]);
  if (permissionDescriptions.length === 0) return;
  await client.query(
    `INSERT INTO linea_permiso (id_rol, id_permiso)
     SELECT $1, id FROM permisos WHERE descripcion = ANY($2)`,
    [rolId, permissionDescriptions]
  );
}

async function create({ descripcion, permissions = [] }) {
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query('INSERT INTO roles (descripcion) VALUES ($1) RETURNING id', [descripcion]);
    await syncPermissions(client, rows[0].id, permissions);
    return rows[0].id;
  });
  return findById(id);
}

async function update(id, { descripcion, permissions }) {
  await withTransaction(async (client) => {
    if (descripcion !== undefined) {
      await client.query('UPDATE roles SET descripcion = $1 WHERE id = $2', [descripcion, id]);
    }
    if (permissions !== undefined) await syncPermissions(client, id, permissions);
  });
  return findById(id);
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM roles WHERE id = $1', [id]);
  return rowCount > 0;
}

async function findAllPermisos() {
  const { rows } = await pool.query('SELECT descripcion FROM permisos ORDER BY descripcion');
  return rows.map(r => r.descripcion);
}

module.exports = { findAll, findById, findBasicById, create, update, remove, findAllPermisos };
