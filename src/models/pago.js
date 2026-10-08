const { pool, withTransaction } = require('../config/db');
const { TZ, HOY_SQL, PERIODO_DIAS } = require('../config/fechas');

// Registra el pago y renueva la cuota del cliente de forma atómica.
// El período arranca en el vencimiento actual (si aún no venció) o en hoy, calculado en SQL
// para usar la fecha de la zona horaria del gimnasio y no la del proceso Node.
async function create({ cliente_id, usuario_id, monto, metodo }) {
  const pagoId = await withTransaction(async (client) => {
    const { rows: clienteRows } = await client.query(
      `SELECT GREATEST(fecha_vencimiento, ${HOY_SQL}) AS desde FROM clientes WHERE id = $1 FOR UPDATE`,
      [cliente_id]
    );
    if (!clienteRows[0]) throw new Error('CLIENTE_NO_ENCONTRADO');
    const desde = clienteRows[0].desde;

    const { rows } = await client.query(
      `INSERT INTO pagos (cliente_id, usuario_id, monto, metodo, periodo_desde, periodo_hasta)
       VALUES ($1,$2,$3,$4,$5::date,$5::date + $6::int) RETURNING id, periodo_hasta`,
      [cliente_id, usuario_id, monto, metodo, desde, PERIODO_DIAS]
    );

    await client.query(
      `UPDATE clientes SET fecha_vencimiento = $1, fecha_inicio_cuota = $2, estado = 'activo', updated_at = now()
       WHERE id = $3`,
      [rows[0].periodo_hasta, desde, cliente_id]
    );
    return rows[0].id;
  });
  return findById(pagoId);
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
    WITH p AS (SELECT monto, (fecha_pago AT TIME ZONE '${TZ}') AS local FROM pagos)
    SELECT
      COALESCE(SUM(monto) FILTER (WHERE local::date = ${HOY_SQL}), 0) AS hoy,
      COALESCE(SUM(monto) FILTER (WHERE local >= date_trunc('week', ${HOY_SQL})), 0) AS semana,
      COALESCE(SUM(monto) FILTER (WHERE local >= date_trunc('month', ${HOY_SQL})), 0) AS mes
    FROM p
  `);
  return rows[0];
}

module.exports = { create, findById, findByCliente, getStatsFacturacion };
