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
  foto_url, contacto_emergencia, observaciones, fecha_alta, fecha_inicio_cuota, fecha_vencimiento,
}) {
  const { rows } = await pool.query(
    `INSERT INTO clientes
      (nombre, apellido, dni, fecha_nacimiento, telefono, email, direccion,
       foto_url, contacto_emergencia, observaciones, fecha_alta, fecha_inicio_cuota, fecha_vencimiento)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [nombre, apellido, dni, fecha_nacimiento ?? null, telefono ?? null, email ?? null,
     direccion ?? null, foto_url ?? null, contacto_emergencia ?? null, observaciones ?? null,
     fecha_alta, fecha_inicio_cuota, fecha_vencimiento]
  );
  return findById(rows[0].id);
}

async function update(id, {
  nombre, apellido, dni, fecha_nacimiento, telefono, email, direccion,
  foto_url, contacto_emergencia, observaciones, fecha_alta, fecha_inicio_cuota, fecha_vencimiento, estado,
}) {
  await pool.query(
    `UPDATE clientes SET
       nombre=$1, apellido=$2, dni=$3, fecha_nacimiento=$4, telefono=$5, email=$6,
       direccion=$7, foto_url=$8, contacto_emergencia=$9, observaciones=$10,
       fecha_alta=$11, fecha_inicio_cuota=$12, fecha_vencimiento=$13, estado=$14, updated_at=now()
     WHERE id=$15`,
    [nombre, apellido, dni, fecha_nacimiento ?? null, telefono ?? null, email ?? null,
     direccion ?? null, foto_url ?? null, contacto_emergencia ?? null, observaciones ?? null,
     fecha_alta, fecha_inicio_cuota, fecha_vencimiento, estado, id]
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
      -- Por fecha_alta (no created_at): un cliente cargado hoy con alta retroactiva no es "nuevo".
      COUNT(*) FILTER (WHERE date_trunc('month', fecha_alta) = date_trunc('month', ${HOY_SQL}))::int AS nuevos_mes
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

// "Cuota de referencia": monto del último pago NO anulado del cliente, sin acumular
// períodos (política acordada para Fase 2 de Facturación). NULL si nunca pagó.
const ULTIMO_PAGO_MONTO_SQL = `(
  SELECT p.monto FROM pagos p
  WHERE p.cliente_id = clientes.id AND p.anulado = false
  ORDER BY p.fecha_pago DESC LIMIT 1
)`;

function buildBusquedaNombreDni(query, p) {
  return query ? ` AND (apellido || ' ' || nombre || ' ' || dni) ILIKE ${p(`%${query}%`)}` : '';
}

// Paginado; devuelve además total_count y total_adeudado (ambos agregados sobre el
// conjunto filtrado completo, no solo la página) vía window functions.
async function findMorosos({ query, limit = 20, offset = 0 } = {}) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = `${ESTADO_CUOTA_SQL} = 'moroso'${buildBusquedaNombreDni(query, p)}`;

  const { rows } = await pool.query(`
    SELECT id, apellido || ', ' || nombre AS nombre_completo, dni, fecha_vencimiento,
      (${HOY_SQL} - fecha_vencimiento)::int AS dias_atraso,
      ${ULTIMO_PAGO_MONTO_SQL} AS monto_referencia,
      COUNT(*) OVER()::int AS total_count,
      COALESCE(SUM(${ULTIMO_PAGO_MONTO_SQL}) OVER(), 0) AS total_adeudado
    FROM clientes
    WHERE ${where}
    ORDER BY dias_atraso DESC, apellido, nombre
    LIMIT ${p(limit)} OFFSET ${p(offset)}
  `, params);

  return {
    rows: rows.map(({ total_count, total_adeudado, ...r }) => r),
    totalCount: rows[0]?.total_count ?? 0,
    totalAdeudado: Number(rows[0]?.total_adeudado ?? 0),
  };
}

async function findPorVencer({ query, limit = 20, offset = 0 } = {}) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = `${ESTADO_CUOTA_SQL} = 'por_vencer'${buildBusquedaNombreDni(query, p)}`;

  const { rows } = await pool.query(`
    SELECT id, apellido || ', ' || nombre AS nombre_completo, dni, fecha_vencimiento,
      (fecha_vencimiento - ${HOY_SQL})::int AS dias_restantes,
      ${ULTIMO_PAGO_MONTO_SQL} AS monto_referencia,
      COUNT(*) OVER()::int AS total_count,
      COALESCE(SUM(${ULTIMO_PAGO_MONTO_SQL}) OVER(), 0) AS proyeccion_ingresos
    FROM clientes
    WHERE ${where}
    ORDER BY fecha_vencimiento ASC, apellido, nombre
    LIMIT ${p(limit)} OFFSET ${p(offset)}
  `, params);

  return {
    rows: rows.map(({ total_count, proyeccion_ingresos, ...r }) => r),
    totalCount: rows[0]?.total_count ?? 0,
    proyeccionIngresos: Number(rows[0]?.proyeccion_ingresos ?? 0),
  };
}

module.exports = {
  findAll, findById, findByDNI, create, update, remove, getStats, getProximosVencimientos,
  findMorosos, findPorVencer,
};
