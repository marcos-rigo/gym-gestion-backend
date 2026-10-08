const pago = require('../models/pago');
const rol = require('../models/rol');
const V = require('../utils/validators');
const { hoyISO } = require('../config/fechas');

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

// El período (desde/hasta) lo calcula el servidor a partir del vencimiento del cliente,
// por eso el vencimiento resultante nunca puede quedar antes de la fecha de pago.
const schema = {
  clienteId: V.uuid('El cliente', { required: true }),
  monto: V.monto({ required: true }),
  metodo: V.enumOf('El método de pago', ['efectivo', 'tarjeta', 'transferencia'], { required: true }),
};

const findAllSchema = {
  desde: V.fecha('Desde'),
  hasta: V.fecha('Hasta'),
  metodo: V.enumOf('El método de pago', ['efectivo', 'tarjeta', 'transferencia']),
  usuarioId: V.uuid('El empleado'),
  estado: V.enumOf('El estado', ['vigente', 'anulado']),
  clienteQuery: V.texto('La búsqueda', { max: 100 }),
};

const anularSchema = {
  motivo: V.texto('El motivo', { required: true, max: 300 }),
};

async function create(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, schema);
    if (!ok) return V.sendValidationError(res, errors);

    const item = await pago.create({ cliente_id: v.clienteId, usuario_id: req.user.id, monto: v.monto, metodo: v.metodo });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.message === 'CLIENTE_NO_ENCONTRADO') {
      return res.status(404).json({ message: 'Cliente no encontrado' });
    }
    console.error('pago.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function anular(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, anularSchema);
    if (!ok) return V.sendValidationError(res, errors);

    const item = await pago.anular({ id: req.params.id, usuario_id: req.user.id, motivo: v.motivo });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.message === 'PAGO_NO_ENCONTRADO') {
      return res.status(404).json({ message: 'Pago no encontrado' });
    }
    if (err.message === 'PAGO_YA_ANULADO') {
      return res.status(409).json({ message: 'Este pago ya fue anulado' });
    }
    if (err.message === 'PAGO_NO_ES_ULTIMO') {
      return res.status(409).json({ message: 'Anulá primero los pagos posteriores de este cliente' });
    }
    if (err.message === 'CLIENTE_NO_ENCONTRADO') {
      return res.status(404).json({ message: 'Cliente no encontrado' });
    }
    console.error('pago.anular error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function findAll(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, findAllSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const page = Number.parseInt(req.query.page, 10) || 1;
    const pageSize = Math.min(Number.parseInt(req.query.pageSize, 10) || 20, 100);
    const filtros = {
      desde: v.desde, hasta: v.hasta, metodo: v.metodo, usuarioId: v.usuarioId,
      estado: v.estado, clienteQuery: v.clienteQuery,
    };

    const [data, total] = await Promise.all([
      pago.findAll({ ...filtros, limit: pageSize, offset: (page - 1) * pageSize }),
      pago.count(filtros),
    ]);
    return res.json({ data: toCamelCase(data), meta: { page, pageSize, total } });
  } catch (err) {
    console.error('pago.findAll error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function findByCliente(req, res) {
  try {
    const data = await pago.findByCliente(req.params.clienteId);
    return res.json({ data: toCamelCase(data) });
  } catch (err) {
    console.error('pago.findByCliente error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function getStats(req, res) {
  try {
    const stats = await pago.getStatsFacturacion();
    return res.json({ data: stats });
  } catch (err) {
    console.error('pago.getStats error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const cierreCajaSchema = { fecha: V.fecha('La fecha') };

// Admin/Dueño ven el cierre completo (todos los empleados); un Empleado solo ve su propio turno.
// Se decide en el backend (no alcanza con ocultarlo en el frontend).
async function getCierreCaja(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, cierreCajaSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const rolData = await rol.findBasicById(req.user.id_rol);
    const verTodos = !!rolData && (rolData.es_admin || rolData.descripcion === 'Dueño');

    const data = await pago.getCierreCaja({
      fecha: v.fecha || hoyISO(),
      usuarioId: verTodos ? undefined : req.user.id,
    });
    return res.json({ data });
  } catch (err) {
    console.error('pago.getCierreCaja error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { create, anular, findAll, findByCliente, getStats, getCierreCaja };
