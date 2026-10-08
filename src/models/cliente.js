const { pool } = require('../config/db');
const { TZ, HOY_SQL, POR_VENCER_DIAS } = require('../config/fechas');

// Única definición del estado de cuota (la usan listados, stats y dashboard).
const ESTADO_CUOTA_SQL = `CASE
  WHEN estado != 'activo' THEN NULL
  WHEN fecha_vencimiento < ${HOY_SQL} THEN 'moroso'
  WHEN fecha_vencimiento <= ${HOY_SQL} + ${POR_VENCER_DIAS} THEN 'por_vencer'
  ELSE 'al_dia'
END`;

const SELECT_CLIENTE = `SELECT *, apellido || ', ' || nombre AS nombre_completo, ${ESTADO_CUOTA_SQL} AS estado_cuota FROM clientes`;

async function findAll() {
  const { rows } = await pool.query(
    `${SELECT_CLIENTE}
     ORDER BY apellido, nombre`
  );
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(
    `${SELECT_CLIENTE} WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

async function findByDNI(dni) {
  const { rows } = await pool.query(
    `${SELECT_CLIENTE} WHERE dni = $1 LIMIT 1`,
    [dni]
  );
  return rows[0] ?? null;
}

async function create({
  nombre, apellido, dni, fecha_nacimiento, telefono, email, direccion,
  foto_url, contacto_emergencia, observaciones, fecha_inicio_cuota, fecha_vencimiento,
}) {
  const { rows } = await pool.query(
    `INSERT INTO clientes
      (nombre, apellido, dni, fecha_nacimiento, telefono, email, direccion,
       foto_url, contacto_emergencia, observaciones, fecha_inicio_cuota, fecha_vencimiento)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [nombre, apellido, dni, fecha_nacimiento ?? null, telefono ?? null, email ?? null,
     direccion ?? null, foto_url ?? null, contacto_emergencia ?? null, observaciones ?? null,
     fecha_inicio_cuota, fecha_vencimiento]
  );
  return findById(rows[0].id);
}

async function update(id, {
  nombre, apellido, dni, fecha_nacimiento, telefono, email, direccion,
  foto_url, contacto_emergencia, observaciones, fecha_inicio_cuota, fecha_vencimiento, estado,
}) {
  await pool.query(
    `UPDATE clientes SET
       nombre=$1, apellido=$2, dni=$3, fecha_nacimiento=$4, telefono=$5, email=$6,
       direccion=$7, foto_url=$8, contacto_emergencia=$9, observaciones=$10,
       fecha_inicio_cuota=$11, fecha_vencimiento=$12, estado=$13, updated_at=now()
     WHERE id=$14`,
    [nombre, apellido, dni, fecha_nacimiento ?? null, telefono ?? null, email ?? null,
     direccion ?? null, foto_url ?? null, contacto_emergencia ?? null, observaciones ?? null,
     fecha_inicio_cuota, fecha_vencimiento, estado, id]
  );
  return findById(id);
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM clientes WHERE id = $1', [id]);
  return rowCount > 0;
}

async function getStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE estado = 'activo')::int AS activos,
      COUNT(*) FILTER (WHERE ${ESTADO_CUOTA_SQL} = 'moroso')::int AS morosos,
      COUNT(*) FILTER (WHERE ${ESTADO_CUOTA_SQL} = 'por_vencer')::int AS por_vencer,
      COUNT(*) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE '${TZ}') = date_trunc('month', ${HOY_SQL}))::int AS nuevos_mes
    FROM clientes
  `);
  return rows[0];
}

// Clientes activos vencidos o por vencer, los más urgentes (vencimiento más antiguo) primero.
async function getProximosVencimientos(limit = 10) {
  const { rows } = await pool.query(`
    SELECT id, apellido || ', ' || nombre AS nombre_completo, telefono, fecha_vencimiento,
      ${ESTADO_CUOTA_SQL} AS estado_cuota
    FROM clientes
    WHERE ${ESTADO_CUOTA_SQL} IN ('moroso', 'por_vencer')
    ORDER BY fecha_vencimiento ASC
    LIMIT $1
  `, [limit]);
  return rows;
}

module.exports = { findAll, findById, findByDNI, create, update, remove, getStats, getProximosVencimientos };
