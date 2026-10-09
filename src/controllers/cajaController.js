const movimientoCaja = require('../models/movimientoCaja');
const cajaApertura = require('../models/cajaApertura');
const pago = require('../models/pago');
const venta = require('../models/venta');
const rol = require('../models/rol');
const V = require('../utils/validators');
const { hoyISO } = require('../config/fechas');
const cierreCaja = require('../models/cierreCaja');
const { TURNOS, turnoDeFecha } = require('../utils/turno');

function toCamelCase(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  if (typeof obj !== 'object') return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

const METODOS = ['efectivo', 'transferencia'];
const TIPOS_MOVIMIENTO = ['egreso', 'ingreso_extra'];

async function verTodos(req) {
  const rolData = await rol.findBasicById(req.user.id_rol);
  return !!rolData && (rolData.es_admin || rolData.descripcion === 'Dueño');
}

const movimientoSchema = {
  tipo: V.enumOf('El tipo', TIPOS_MOVIMIENTO, { required: true }),
  concepto: V.texto('El concepto', { required: true, max: 200 }),
  monto: V.monto({ required: true }),
  metodo: V.enumOf('El método', METODOS, { required: true }),
};

async function crearMovimiento(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, movimientoSchema);
    if (!ok) return V.sendValidationError(res, errors);

    const item = await movimientoCaja.create({
      tipo: v.tipo, concepto: v.concepto, monto: v.monto, metodo: v.metodo, usuario_id: req.user.id,
    });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('caja.crearMovimiento error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const listadoMovimientosSchema = {
  fecha: V.fecha('La fecha'),
  tipo: V.enumOf('El tipo', TIPOS_MOVIMIENTO),
  turno: V.enumOf('El turno', TURNOS),
};

async function listarMovimientos(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, listadoMovimientosSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const todos = await verTodos(req);
    const data = await movimientoCaja.findByFecha({
      fecha: v.fecha || hoyISO(), tipo: v.tipo, turno: v.turno, usuarioId: todos ? undefined : req.user.id,
    });
    return res.json({ data: toCamelCase(data) });
  } catch (err) {
    console.error('caja.listarMovimientos error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const anularSchema = { motivo: V.texto('El motivo', { required: true, max: 300 }) };

async function anularMovimiento(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, anularSchema);
    if (!ok) return V.sendValidationError(res, errors);

    const item = await movimientoCaja.anular({ id: req.params.id, usuario_id: req.user.id, motivo: v.motivo });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.message === 'MOVIMIENTO_NO_ENCONTRADO') return res.status(404).json({ message: 'Movimiento no encontrado' });
    if (err.message === 'MOVIMIENTO_YA_ANULADO') return res.status(409).json({ message: 'Este movimiento ya fue anulado' });
    console.error('caja.anularMovimiento error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const aperturaFechaSchema = { fecha: V.fecha('La fecha') };

async function getApertura(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, aperturaFechaSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);
    const item = await cajaApertura.findByFecha(v.fecha || hoyISO());
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('caja.getApertura error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const putAperturaSchema = {
  fecha: V.fecha('La fecha'),
  montoInicialEfectivo: V.monto({ required: true }),
};

async function putApertura(req, res) {
  try {
    // El monto puede ser 0 (caja en cero), así que no usamos V.monto (exige > 0) para el mínimo;
    // V.monto ya valida formato/decimales, solo relajamos la cota inferior acá.
    const { ok, values: v, errors } = V.validate(req.body, { fecha: V.fecha('La fecha') }, { partial: true });
    const raw = req.body?.montoInicialEfectivo;
    const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
    if (s === null || !/^\d+(\.\d{1,2})?$/.test(s)) {
      errors.montoInicialEfectivo = 'El monto inicial debe ser un número mayor o igual a 0, con hasta 2 decimales';
    }
    if (!ok || Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    const item = await cajaApertura.upsert({
      fecha: v.fecha || hoyISO(), monto_inicial_efectivo: Number(s), usuario_id: req.user.id,
    });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('caja.putApertura error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const cierreSchema = { fecha: V.fecha('La fecha') };

// Cierre de caja integrado: cuotas + ventas + egresos/ingresos extra + apertura.
// efectivoEsperado = inicio + cuotas efectivo + ventas efectivo + ingresos extra efectivo - egresos efectivo.
// Transferencias se informan aparte (no entran al efectivo esperado). Todo con scoping
// Empleado (solo lo propio) vs Admin/Dueño (todo), decidido en el servidor.
async function getCierre(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, cierreSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);
    const fecha = v.fecha || hoyISO();
    const todos = await verTodos(req);
    const usuarioId = todos ? undefined : req.user.id;

    const [cuotas, ventas, apertura, movimientos] = await Promise.all([
      pago.getCierreCaja({ fecha, usuarioId }),
      venta.getTotalesDia({ fecha, usuarioId }),
      cajaApertura.findByFecha(fecha),
      movimientoCaja.getTotalesDia({ fecha, usuarioId }),
    ]);

    const montoPorMetodo = (lista, metodo) => Number(lista.find((x) => x.metodo === metodo)?.monto ?? 0);
    const cuotasEfectivo = montoPorMetodo(cuotas.porMetodo, 'efectivo');
    const cuotasTransferencia = montoPorMetodo(cuotas.porMetodo, 'transferencia');
    const ventasEfectivo = montoPorMetodo(ventas.porMetodo, 'efectivo');
    const ventasTransferencia = montoPorMetodo(ventas.porMetodo, 'transferencia');

    const egresos = movimientos.filter((m) => m.tipo === 'egreso');
    const ingresosExtra = movimientos.filter((m) => m.tipo === 'ingreso_extra');
    const egresosEfectivo = montoPorMetodo(egresos, 'efectivo');
    const egresosTransferencia = montoPorMetodo(egresos, 'transferencia');
    const ingresosExtraEfectivo = montoPorMetodo(ingresosExtra, 'efectivo');
    const ingresosExtraTransferencia = montoPorMetodo(ingresosExtra, 'transferencia');

    const montoInicial = Number(apertura?.monto_inicial_efectivo ?? 0);
    const efectivoEsperado = montoInicial + cuotasEfectivo + ventasEfectivo + ingresosExtraEfectivo - egresosEfectivo;
    const transferenciasTotal = cuotasTransferencia + ventasTransferencia + ingresosExtraTransferencia - egresosTransferencia;

    // Empleado -> { cuotas, ventas } combinado, por tipo (así el front puede mostrar el desglose
    // sin tener que volver a sumar él mismo).
    const porEmpleadoMap = new Map();
    const empKey = (id) => id ?? 'sin-empleado';
    for (const e of cuotas.porEmpleado) {
      porEmpleadoMap.set(empKey(e.usuarioId), {
        usuarioId: e.usuarioId, usuarioNombre: e.usuarioNombre,
        cuotas: { monto: e.monto, cantidad: e.cantidad },
        ventas: { monto: 0, cantidad: 0 },
      });
    }
    for (const e of ventas.porEmpleado) {
      const acc = porEmpleadoMap.get(empKey(e.usuarioId)) ?? {
        usuarioId: e.usuarioId, usuarioNombre: e.usuarioNombre,
        cuotas: { monto: 0, cantidad: 0 }, ventas: { monto: 0, cantidad: 0 },
      };
      acc.ventas = { monto: e.monto, cantidad: e.cantidad };
      porEmpleadoMap.set(empKey(e.usuarioId), acc);
    }

    return res.json({
      data: {
        fecha,
        aperturaInicialEfectivo: montoInicial,
        efectivoEsperado,
        transferenciasTotal,
        porTipo: {
          cuotas: { efectivo: cuotasEfectivo, transferencia: cuotasTransferencia, cantidad: cuotas.general.cantidad },
          ventas: { efectivo: ventasEfectivo, transferencia: ventasTransferencia, cantidad: ventas.cantidad },
          egresos: { efectivo: egresosEfectivo, transferencia: egresosTransferencia, cantidad: egresos.reduce((a, m) => a + m.cantidad, 0) },
          ingresosExtra: { efectivo: ingresosExtraEfectivo, transferencia: ingresosExtraTransferencia, cantidad: ingresosExtra.reduce((a, m) => a + m.cantidad, 0) },
        },
        porEmpleado: [...porEmpleadoMap.values()],
        anulados: {
          cuotas: cuotas.anulados,
          ventas: ventas.anulados,
        },
      },
    });
  } catch (err) {
    console.error('caja.getCierre error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

// Cierre por turno: un registro por (fecha, turno), con snapshot de totales por método y empleados.
// Sin fecha = hoy; sin turno = el turno actual (solo válido para hoy: una fecha pasada necesita turno).
const crearCierreSchema = {
  fecha: V.fecha('La fecha'),
  turno: V.enumOf('El turno', TURNOS),
};

// Forma común del cierre de un turno, sea guardado (snapshot) o en vivo. `totalPorMetodo.mixto` es
// informativo (cobros divididos, ya incluidos en efectivo/transferencia), no suma al total.
function presentarTotales(t) {
  return {
    totalPorMetodo: { efectivo: t.totalEfectivo, transferencia: t.totalTransferencia, mixto: t.totalMixto },
    total: t.total,
    totalCuotas: t.totalCuotas,
    totalVentas: t.totalVentas,
    totalIngresosExtra: t.totalIngresosExtra,
    totalEgresos: t.totalEgresos,
    cantidadPagos: t.cantidadPagos,
    desglose: t.detalle,
    empleados: t.empleados,
  };
}

function presentarCierre(c) {
  return {
    id: c.id,
    fecha: c.fecha,
    turno: c.turno,
    totalPorMetodo: {
      efectivo: Number(c.total_efectivo),
      transferencia: Number(c.total_transferencia),
      mixto: Number(c.total_mixto),
    },
    total: Number(c.total),
    totalCuotas: Number(c.total_cuotas),
    totalVentas: Number(c.total_ventas),
    totalIngresosExtra: Number(c.total_ingresos_extra),
    totalEgresos: Number(c.total_egresos),
    cantidadPagos: c.cantidad_pagos,
    desglose: c.detalle,
    empleados: c.empleados,
    creadoPorNombre: c.creado_por_nombre ?? null,
    createdAt: c.created_at,
  };
}

async function crearCierre(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body ?? {}, crearCierreSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const fecha = v.fecha || hoyISO();
    const turno = v.turno ?? (fecha === hoyISO() ? turnoDeFecha(new Date()) : null);
    if (!turno) return V.sendValidationError(res, { turno: 'Indicá el turno para cerrar una fecha que no es hoy' });

    const totales = await cierreCaja.getTotalesTurno({ fecha, turno });
    const item = await cierreCaja.create({ fecha, turno, totales, usuario_id: req.user.id });
    return res.status(201).json({ data: presentarCierre(item) });
  } catch (err) {
    if (err.code === '23505') {
      return V.sendConflict(res, 'Este turno ya fue cerrado', { turno: 'Ya existe un cierre para esta fecha y turno' });
    }
    console.error('caja.crearCierre error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const listarCierresSchema = {
  fecha: V.fecha('La fecha'),
  turno: V.enumOf('El turno', [...TURNOS, 'ambos']),
};

async function listarCierres(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, listarCierresSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const data = await cierreCaja.findAll({
      fecha: v.fecha || undefined,
      turno: v.turno && v.turno !== 'ambos' ? v.turno : undefined,
    });
    return res.json({ data: data.map(presentarCierre) });
  } catch (err) {
    console.error('caja.listarCierres error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

// Estado de un turno: si ya está cerrado devuelve el snapshot; si no, el resumen en vivo.
// Sirve para recalcular al cambiar fecha/turno y para que "cerrado" persista al recargar.
const estadoTurnoSchema = {
  fecha: V.fecha('La fecha'),
  turno: V.enumOf('El turno', TURNOS),
};

async function getEstadoTurno(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, estadoTurnoSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const fecha = v.fecha || hoyISO();
    const turno = v.turno ?? (fecha === hoyISO() ? turnoDeFecha(new Date()) : null);
    if (!turno) return V.sendValidationError(res, { turno: 'Indicá el turno para una fecha que no es hoy' });

    const [cierre] = await cierreCaja.findAll({ fecha, turno });
    const enVivo = cierre ? null : presentarTotales(await cierreCaja.getTotalesTurno({ fecha, turno }));

    return res.json({
      data: {
        fecha,
        turno,
        turnoActual: turnoDeFecha(new Date()),
        cerrado: cierre ? presentarCierre(cierre) : null,
        enVivo,
      },
    });
  } catch (err) {
    console.error('caja.getEstadoTurno error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = {
  crearMovimiento, listarMovimientos, anularMovimiento, getApertura, putApertura, getCierre,
  crearCierre, listarCierres, getEstadoTurno,
};
