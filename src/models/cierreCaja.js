const { pool } = require('../config/db');
const { TZ } = require('../config/fechas');
const { turnoSql } = require('../utils/turno');

// Totales integrados de un turno (cuotas + ventas + ingresos extra - egresos), mismo criterio que el
// cierre integrado de /api/caja/cierre pero acotado al turno. Solo lo vigente (no anulado).
// Por método se usa el desglose por componente (pago_metodos, venta_pagos) para que el efectivo cuadre
// con la caja real; el cobro mixto aparte es informativo porque ya está en efectivo/transferencia.
// Apertura no entra: es por día, no por turno.
const enTurno = (col) => `(${col} AT TIME ZONE '${TZ}')::date = $1::date AND ${turnoSql(col)} = $2`;

const montoDe = (rows, metodo) => Number(rows.find((r) => r.metodo === metodo)?.monto ?? 0);
const sumaDe = (rows) => rows.reduce((acc, r) => acc + Number(r.monto), 0);

async function getTotalesTurno({ fecha, turno }) {
  const params = [fecha, turno];
  const [cuotasPorMetodo, cuotas, ventasPorMetodo, ventas, movimientos, empleados] = await Promise.all([
    pool.query(`
      SELECT pm.metodo, COALESCE(SUM(pm.monto), 0) AS monto
      FROM pagos p JOIN pago_metodos pm ON pm.id_pago = p.id
      WHERE p.anulado = false AND ${enTurno('p.fecha_pago')}
      GROUP BY pm.metodo
    `, params),
    pool.query(`
      SELECT COALESCE(SUM(p.monto), 0) AS monto, COUNT(*)::int AS cantidad,
        COALESCE(SUM(p.monto) FILTER (WHERE p.metodo = 'mixto'), 0) AS mixto
      FROM pagos p
      WHERE p.anulado = false AND ${enTurno('p.fecha_pago')}
    `, params),
    pool.query(`
      SELECT vp.metodo, COALESCE(SUM(vp.monto), 0) AS monto
      FROM ventas v JOIN venta_pagos vp ON vp.id_venta = v.id
      WHERE v.anulada = false AND ${enTurno('v.fecha_hora')}
      GROUP BY vp.metodo
    `, params),
    pool.query(`
      SELECT COALESCE(SUM(v.total), 0) AS monto, COUNT(*)::int AS cantidad
      FROM ventas v
      WHERE v.anulada = false AND ${enTurno('v.fecha_hora')}
    `, params),
    pool.query(`
      SELECT m.tipo, m.metodo, COALESCE(SUM(m.monto), 0) AS monto
      FROM movimientos_caja m
      WHERE m.anulado = false AND ${enTurno('m.fecha_hora')}
      GROUP BY m.tipo, m.metodo
    `, params),
    pool.query(`
      SELECT DISTINCT x.id, u.nombre FROM (
        SELECT p.usuario_id AS id FROM pagos p WHERE p.anulado = false AND ${enTurno('p.fecha_pago')}
        UNION SELECT v.id_usuario FROM ventas v WHERE v.anulada = false AND ${enTurno('v.fecha_hora')}
        UNION SELECT m.id_usuario FROM movimientos_caja m WHERE m.anulado = false AND ${enTurno('m.fecha_hora')}
      ) x
      JOIN usuarios u ON u.id = x.id
      ORDER BY u.nombre
    `, params),
  ]);

  const movPor = (tipo) => movimientos.rows.filter((r) => r.tipo === tipo);
  const ingresos = movPor('ingreso_extra');
  const egresos = movPor('egreso');

  const detalle = {
    cuotas: {
      efectivo: montoDe(cuotasPorMetodo.rows, 'efectivo'),
      transferencia: montoDe(cuotasPorMetodo.rows, 'transferencia'),
      total: Number(cuotas.rows[0].monto),
      cantidad: cuotas.rows[0].cantidad,
      cobrosMixtos: Number(cuotas.rows[0].mixto),
    },
    ventas: {
      efectivo: montoDe(ventasPorMetodo.rows, 'efectivo'),
      transferencia: montoDe(ventasPorMetodo.rows, 'transferencia'),
      total: Number(ventas.rows[0].monto),
      cantidad: ventas.rows[0].cantidad,
    },
    ingresosExtra: {
      efectivo: montoDe(ingresos, 'efectivo'),
      transferencia: montoDe(ingresos, 'transferencia'),
      total: sumaDe(ingresos),
    },
    egresos: {
      efectivo: montoDe(egresos, 'efectivo'),
      transferencia: montoDe(egresos, 'transferencia'),
      total: sumaDe(egresos),
    },
  };

  const neto = (metodo) => detalle.cuotas[metodo] + detalle.ventas[metodo] + detalle.ingresosExtra[metodo] - detalle.egresos[metodo];
  const totalCuotas = detalle.cuotas.total;
  const totalVentas = detalle.ventas.total;
  const totalIngresosExtra = detalle.ingresosExtra.total;
  const totalEgresos = detalle.egresos.total;

  return {
    totalEfectivo: neto('efectivo'),
    totalTransferencia: neto('transferencia'),
    totalMixto: detalle.cuotas.cobrosMixtos,
    total: totalCuotas + totalVentas + totalIngresosExtra - totalEgresos,
    totalCuotas,
    totalVentas,
    totalIngresosExtra,
    totalEgresos,
    cantidadPagos: detalle.cuotas.cantidad,
    empleados: empleados.rows.map((r) => ({ usuarioId: r.id, usuarioNombre: r.nombre })),
    detalle,
  };
}

const SELECT_CIERRE = `
  SELECT c.*, u.nombre AS creado_por_nombre
  FROM cierre_caja c
  LEFT JOIN usuarios u ON u.id = c.creado_por
`;

async function findById(id) {
  const { rows } = await pool.query(`${SELECT_CIERRE} WHERE c.id = $1`, [id]);
  return rows[0] ?? null;
}

// Inserta el cierre de un (fecha, turno). Si ya existe, Postgres lanza 23505 (lo mapea el controller a 409).
async function create({ fecha, turno, totales, usuario_id }) {
  const { rows } = await pool.query(
    `INSERT INTO cierre_caja (fecha, turno, total_efectivo, total_transferencia, total_mixto, total,
                              total_cuotas, total_ventas, total_ingresos_extra, total_egresos,
                              cantidad_pagos, empleados, detalle, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      fecha, turno, totales.totalEfectivo, totales.totalTransferencia, totales.totalMixto, totales.total,
      totales.totalCuotas, totales.totalVentas, totales.totalIngresosExtra, totales.totalEgresos,
      totales.cantidadPagos, JSON.stringify(totales.empleados), JSON.stringify(totales.detalle), usuario_id,
    ]
  );
  return findById(rows[0].id);
}

// Listado con filtros opcionales por fecha y turno (sin turno = ambos turnos).
async function findAll({ fecha, turno } = {}) {
  const params = [];
  const where = ['1=1'];
  if (fecha) { params.push(fecha); where.push(`c.fecha = $${params.length}::date`); }
  if (turno) { params.push(turno); where.push(`c.turno = $${params.length}`); }
  const { rows } = await pool.query(
    `${SELECT_CIERRE} WHERE ${where.join(' AND ')} ORDER BY c.fecha DESC, c.turno`,
    params
  );
  return rows;
}

module.exports = { findById, create, findAll, getTotalesTurno };
