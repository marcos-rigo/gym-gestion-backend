const pago = require('../models/pago');

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

async function create(req, res) {
  try {
    const { clienteId, monto, metodo } = req.body;
    if (!clienteId || !monto || !metodo) {
      return res.status(400).json({ message: 'clienteId, monto y metodo son requeridos' });
    }
    if (!['efectivo', 'tarjeta', 'transferencia'].includes(metodo)) {
      return res.status(400).json({ message: 'Método de pago inválido' });
    }
    const item = await pago.create({ cliente_id: clienteId, usuario_id: req.user.id, monto, metodo });
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
