const { pool } = require('../config/db');

async function findAll() {
  const { rows } = await pool.query(
    `SELECT *, apellido || ', ' || nombre AS nombre_completo,
       CASE
         WHEN estado != 'activo' THEN NULL
         WHEN fecha_vencimiento < current_date THEN 'moroso'
         WHEN fecha_vencimiento <= current_date + interval '2 days' THEN 'por_vencer'
         ELSE 'al_dia'
       END AS estado_cuota
     FROM clientes
     ORDER BY apellido, nombre`
  );
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(
    `SELECT *, apellido || ', ' || nombre AS nombre_completo,
       CASE
         WHEN estado != 'activo' THEN NULL
         WHEN fecha_vencimiento < current_date THEN 'moroso'
         WHEN fecha_vencimiento <= current_date + interval '2 days' THEN 'por_vencer'
         ELSE 'al_dia'
       END AS estado_cuota
     FROM clientes WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

async function findByDNI(dni) {
  const { rows } = await pool.query(
    `SELECT *, apellido || ', ' || nombre AS nombre_completo,
       CASE
         WHEN estado != 'activo' THEN NULL
         WHEN fecha_vencimiento < current_date THEN 'moroso'
         WHEN fecha_vencimiento <= current_date + interval '2 days' THEN 'por_vencer'
         ELSE 'al_dia'
       END AS estado_cuota
     FROM clientes WHERE dni = $1 LIMIT 1`,
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
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE estado = 'activo') AS activos,
      COUNT(*) FILTER (WHERE estado = 'activo' AND fecha_vencimiento < current_date) AS morosos,
      COUNT(*) FILTER (WHERE estado = 'activo' AND fecha_vencimiento >= current_date AND fecha_vencimiento <= current_date + interval '7 days') AS por_vencer,
      COUNT(*) FILTER (WHERE date_trunc('month', created_at) = date_trunc('month', current_date)) AS nuevos_mes
    FROM clientes
  `);
  return rows[0];
}

async function getProximosVencimientos(limit = 10) {
  const { rows } = await pool.query(`
    SELECT id, apellido || ', ' || nombre AS nombre_completo, telefono, fecha_vencimiento,
      CASE
        WHEN fecha_vencimiento < current_date THEN 'moroso'
        WHEN fecha_vencimiento <= current_date + interval '2 days' THEN 'por_vencer'
        ELSE 'al_dia'
      END AS estado_cuota
    FROM clientes
    WHERE estado = 'activo' AND fecha_vencimiento <= current_date + interval '7 days'
    ORDER BY fecha_vencimiento ASC
    LIMIT $1
  `, [limit]);
  return rows;
}

module.exports = { findAll, findById, findByDNI, create, update, remove, getStats, getProximosVencimientos };
