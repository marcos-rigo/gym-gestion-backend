const pago = require('../models/pago');
const V = require('../utils/validators');

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
    return res.json({
      data: { hoy: Number(stats.hoy), semana: Number(stats.semana), mes: Number(stats.mes) }
    });
  } catch (err) {
    console.error('pago.getStats error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { create, findByCliente, getStats };
