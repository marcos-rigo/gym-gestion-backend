const { pool } = require('../config/db');
const { TZ } = require('../config/fechas');

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM movimientos_caja WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function create({ tipo, concepto, monto, metodo, usuario_id }) {
  const { rows } = await pool.query(
    `INSERT INTO movimientos_caja (tipo, concepto, monto, metodo, id_usuario)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tipo, concepto, monto, metodo, usuario_id]
  );
  return findById(rows[0].id);
}

async function findByFecha({ fecha, usuarioId, tipo } = {}) {
  const params = [fecha];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = [`(m.fecha_hora AT TIME ZONE '${TZ}')::date = $1::date`];
  if (usuarioId) where.push(`m.id_usuario = ${p(usuarioId)}`);
  if (tipo) where.push(`m.tipo = ${p(tipo)}`);

  const { rows } = await pool.query(`
    SELECT m.*, u.nombre AS usuario_nombre, a.nombre AS anulado_por_nombre
    FROM movimientos_caja m
    LEFT JOIN usuarios u ON u.id = m.id_usuario
    LEFT JOIN usuarios a ON a.id = m.anulado_por
    WHERE ${where.join(' AND ')}
    ORDER BY m.fecha_hora DESC
  `, params);
  return rows;
}

async function anular({ id, usuario_id, motivo }) {
  const { rows: existing } = await pool.query('SELECT anulado FROM movimientos_caja WHERE id = $1', [id]);
  if (!existing[0]) throw new Error('MOVIMIENTO_NO_ENCONTRADO');
  if (existing[0].anulado) throw new Error('MOVIMIENTO_YA_ANULADO');

  await pool.query(
    `UPDATE movimientos_caja SET anulado = true, anulado_at = now(), anulado_por = $2, motivo_anulacion = $3
     WHERE id = $1`,
    [id, usuario_id, motivo]
  );
  return findById(id);
}

// Totales del día (vigentes) por tipo y método, para el cierre de caja integrado.
async function getTotalesDia({ fecha, usuarioId } = {}) {
  const params = [fecha];
  let filtroUsuario = '';
  if (usuarioId) { params.push(usuarioId); filtroUsuario = ' AND m.id_usuario = $2'; }

  const { rows } = await pool.query(`
    SELECT m.tipo, m.metodo, COALESCE(SUM(m.monto), 0) AS monto, COUNT(*)::int AS cantidad
    FROM movimientos_caja m
    WHERE (m.fecha_hora AT TIME ZONE '${TZ}')::date = $1::date AND m.anulado = false${filtroUsuario}
    GROUP BY m.tipo, m.metodo
  `, params);
  return rows.map((r) => ({ tipo: r.tipo, metodo: r.metodo, monto: Number(r.monto), cantidad: r.cantidad }));
}

module.exports = { create, findById, findByFecha, anular, getTotalesDia };
