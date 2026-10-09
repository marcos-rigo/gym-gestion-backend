const cliente = require('../models/cliente');
const venta = require('../models/venta');

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

async function getStats(req, res) {
  try {
    const stats = await cliente.getStats();
    const proximosVencimientos = await cliente.getProximosVencimientos();
    const ventasHoy = await venta.getTotalHoy();
    return res.json({
      data: {
        total: Number(stats.total),
        activos: Number(stats.activos),
        morosos: Number(stats.morosos),
        porVencer: Number(stats.por_vencer),
        nuevosMes: Number(stats.nuevos_mes),
        proximosVencimientos: toCamelCase(proximosVencimientos),
        ventasHoyTotal: ventasHoy.total,
        ventasHoyCantidad: ventasHoy.cantidad,
      }
    });
  } catch (err) {
    console.error('dashboard.getStats error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getStats };
