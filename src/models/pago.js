const { pool } = require('../config/db');

async function create({ cliente_id, usuario_id, monto, metodo }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: clienteRows } = await client.query(
      'SELECT fecha_vencimiento FROM clientes WHERE id = $1 FOR UPDATE', [cliente_id]
    );
    if (!clienteRows[0]) throw new Error('CLIENTE_NO_ENCONTRADO');

    const vencimientoActual = new Date(clienteRows[0].fecha_vencimiento);
    const hoy = new Date();
    const periodoDesde = vencimientoActual > hoy ? vencimientoActual : hoy;
    const periodoHasta = new Date(periodoDesde.getTime() + 30 * 86400000);

    const periodoDesdeStr = periodoDesde.toISOString().slice(0, 10);
    const periodoHastaStr = periodoHasta.toISOString().slice(0, 10);

    const { rows } = await client.query(
      `INSERT INTO pagos (cliente_id, usuario_id, monto, metodo, periodo_desde, periodo_hasta)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [cliente_id, usuario_id, monto, metodo, periodoDesdeStr, periodoHastaStr]
    );

    await client.query(
      `UPDATE clientes SET fecha_vencimiento = $1, fecha_inicio_cuota = $2, estado = 'activo', updated_at = now() WHERE id = $3`,
      [periodoHastaStr, periodoDesdeStr, cliente_id]
    );

    await client.query('COMMIT');
    return findById(rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM pagos WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function findByCliente(cliente_id) {
  const { rows } = await pool.query(
    'SELECT * FROM pagos WHERE cliente_id = $1 ORDER BY fecha_pago DESC', [cliente_id]
  );
  return rows;
}

async function getStatsFacturacion() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(SUM(monto) FILTER (WHERE fecha_pago::date = current_date), 0) AS hoy,
      COALESCE(SUM(monto) FILTER (WHERE fecha_pago >= date_trunc('week', current_date)), 0) AS semana,
      COALESCE(SUM(monto) FILTER (WHERE fecha_pago >= date_trunc('month', current_date)), 0) AS mes
    FROM pagos
  `);
  return rows[0];
}

module.exports = { create, findById, findByCliente, getStatsFacturacion };
