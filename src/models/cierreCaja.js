const { pool } = require('../config/db');
const { TZ } = require('../config/fechas');
const { turnoSql } = require('../utils/turno');

// Totales integrados (cuotas + ventas + ingresos extra - egresos), mismo criterio que el cierre
// integrado de /api/caja/cierre. Solo lo vigente (no anulado).
// Por método se usa el desglose por componente (pago_metodos, venta_pagos) para que el efectivo cuadre
// con la caja real; el cobro mixto aparte es informativo porque ya está en efectivo/transferencia.
// Apertura no entra: es por día, no por turno.
//
// Núcleo: getTotalesPorDia calcula los totales de cada día local de [desde, hasta], opcionalmente
// acotados a un turno. getTotalesTurno (cierre de turno) es el caso de un solo día; el reporte de
// recaudación usa el rango completo y suma los días con sumarTotales.
const DIA = (col) => `(${col} AT TIME ZONE '${TZ}')::date`;
// $1 = desde, $2 = hasta, $3 = turno (solo si se filtra por turno).
const enRango = (col, conTurno) =>
  `${DIA(col)} BETWEEN $1::date AND $2::date${conTurno ? ` AND ${turnoSql(col)} = $3` : ''}`;

const montoDe = (rows, metodo) => Number(rows.find((r) => r.metodo === metodo)?.monto ?? 0);
const sumaDe = (rows) => rows.reduce((acc, r) => acc + Number(r.monto), 0);

// Arma el objeto de totales con las filas de UN día (cualquiera de las listas puede venir vacía).
function armarTotales({ cuotasPorMetodo = [], cuotas, ventasPorMetodo = [], ventas, movimientos = [], empleados = [] }) {
  const movPor = (tipo) => movimientos.filter((r) => r.tipo === tipo);
  const ingresos = movPor('ingreso_extra');
  const egresos = movPor('egreso');

  const detalle = {
    cuotas: {
      efectivo: montoDe(cuotasPorMetodo, 'efectivo'),
      transferencia: montoDe(cuotasPorMetodo, 'transferencia'),
      total: Number(cuotas?.monto ?? 0),
      cantidad: cuotas?.cantidad ?? 0,
      cobrosMixtos: Number(cuotas?.mixto ?? 0),
    },
    ventas: {
      efectivo: montoDe(ventasPorMetodo, 'efectivo'),
      transferencia: montoDe(ventasPorMetodo, 'transferencia'),
      total: Number(ventas?.monto ?? 0),
      cantidad: ventas?.cantidad ?? 0,
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
    empleados: empleados.map((r) => ({ usuarioId: r.id, usuarioNombre: r.nombre })),
    detalle,
  };
}

// [{ fecha, totales }] por cada día con actividad vigente en [desde, hasta], ordenado por fecha.
async function getTotalesPorDia({ desde, hasta, turno }) {
  const conTurno = !!turno;
  const params = conTurno ? [desde, hasta, turno] : [desde, hasta];
  const [cuotasPorMetodo, cuotas, ventasPorMetodo, ventas, movimientos, empleados] = await Promise.all([
    pool.query(`
      SELECT ${DIA('p.fecha_pago')}::text AS dia, pm.metodo, COALESCE(SUM(pm.monto), 0) AS monto
      FROM pagos p JOIN pago_metodos pm ON pm.id_pago = p.id
      WHERE p.anulado = false AND ${enRango('p.fecha_pago', conTurno)}
      GROUP BY 1, pm.metodo
    `, params),
    pool.query(`
      SELECT ${DIA('p.fecha_pago')}::text AS dia, COALESCE(SUM(p.monto), 0) AS monto, COUNT(*)::int AS cantidad,
        COALESCE(SUM(p.monto) FILTER (WHERE p.metodo = 'mixto'), 0) AS mixto
      FROM pagos p
      WHERE p.anulado = false AND ${enRango('p.fecha_pago', conTurno)}
      GROUP BY 1
    `, params),
    pool.query(`
      SELECT ${DIA('v.fecha_hora')}::text AS dia, vp.metodo, COALESCE(SUM(vp.monto), 0) AS monto
      FROM ventas v JOIN venta_pagos vp ON vp.id_venta = v.id
      WHERE v.anulada = false AND ${enRango('v.fecha_hora', conTurno)}
      GROUP BY 1, vp.metodo
    `, params),
    pool.query(`
      SELECT ${DIA('v.fecha_hora')}::text AS dia, COALESCE(SUM(v.total), 0) AS monto, COUNT(*)::int AS cantidad
      FROM ventas v
      WHERE v.anulada = false AND ${enRango('v.fecha_hora', conTurno)}
      GROUP BY 1
    `, params),
    pool.query(`
      SELECT ${DIA('m.fecha_hora')}::text AS dia, m.tipo, m.metodo, COALESCE(SUM(m.monto), 0) AS monto
      FROM movimientos_caja m
      WHERE m.anulado = false AND ${enRango('m.fecha_hora', conTurno)}
      GROUP BY 1, m.tipo, m.metodo
    `, params),
    pool.query(`
      SELECT DISTINCT x.dia, x.id, u.nombre FROM (
        SELECT ${DIA('p.fecha_pago')}::text AS dia, p.usuario_id AS id FROM pagos p
          WHERE p.anulado = false AND ${enRango('p.fecha_pago', conTurno)}
        UNION SELECT ${DIA('v.fecha_hora')}::text, v.id_usuario FROM ventas v
          WHERE v.anulada = false AND ${enRango('v.fecha_hora', conTurno)}
        UNION SELECT ${DIA('m.fecha_hora')}::text, m.id_usuario FROM movimientos_caja m
          WHERE m.anulado = false AND ${enRango('m.fecha_hora', conTurno)}
      ) x
      JOIN usuarios u ON u.id = x.id
      ORDER BY x.dia, u.nombre
    `, params),
  ]);

  const delDia = (res, dia) => res.rows.filter((r) => r.dia === dia);
  const dias = [...new Set([cuotas, ventas, movimientos].flatMap((res) => res.rows.map((r) => r.dia)))].sort();
  return dias.map((dia) => ({
    fecha: dia,
    totales: armarTotales({
      cuotasPorMetodo: delDia(cuotasPorMetodo, dia),
      cuotas: delDia(cuotas, dia)[0],
      ventasPorMetodo: delDia(ventasPorMetodo, dia),
      ventas: delDia(ventas, dia)[0],
      movimientos: delDia(movimientos, dia),
      empleados: delDia(empleados, dia),
    }),
  }));
}

async function getTotalesTurno({ fecha, turno }) {
  const [dia] = await getTotalesPorDia({ desde: fecha, hasta: fecha, turno });
  return dia ? dia.totales : armarTotales({});
}

// Suma una lista de totales (de distintos días o turnos) en un único objeto con la misma forma.
// Los montos se redondean a centavos para no arrastrar error de punto flotante.
function sumarTotales(lista) {
  const sumar = (acc, x) => {
    for (const [k, v] of Object.entries(x)) {
      if (typeof v === 'number') acc[k] = Math.round(((acc[k] ?? 0) + v) * 100) / 100;
      else if (v && typeof v === 'object' && !Array.isArray(v)) sumar(acc[k], v);
    }
    return acc;
  };
  const total = lista.reduce(sumar, armarTotales({}));
  const empleados = new Map();
  for (const t of lista) for (const e of t.empleados) empleados.set(e.usuarioId, e);
  total.empleados = [...empleados.values()].sort((a, b) => a.usuarioNombre.localeCompare(b.usuarioNombre));
  return total;
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

module.exports = { findById, create, findAll, getTotalesTurno, getTotalesPorDia, sumarTotales };
