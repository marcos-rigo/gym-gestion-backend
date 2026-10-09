const venta = require('../models/venta');
const V = require('../utils/validators');

// A diferencia del toCamelCase (deliberadamente superficial) del resto de los controllers,
// este es recursivo: una venta siempre viaja con items/pagos anidados (snake_case desde SQL)
// y el front espera camelCase en todos los niveles, no solo en el objeto venta de arriba.
function toCamelCase(obj) {
  // OJO: a diferencia del guard superficial `if (!obj) return null` que usan los demás
  // controllers (ahí `obj` siempre es el objeto de respuesta completo, nunca un valor anidado),
  // acá toCamelCase se llama recursivamente sobre cada valor anidado. `!obj` trataría `false`,
  // `0` y `''` como "vacío" y los convertiría en `null` (p. ej. `anulada: false` -> `null`).
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  if (obj instanceof Date) return obj;
  if (typeof obj !== 'object') return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    result[camelKey] = toCamelCase(value);
  }
  return result;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METODOS = ['efectivo', 'transferencia'];

// Items y pagos son arrays de objetos: no encajan en el sistema de reglas de V.validate
// (pensado para campos planos), así que se validan a mano con el mismo shape de error
// { message, errors: { campo: mensaje } } que usa el resto de la API.
function validarItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Debe incluir al menos un ítem' };
  for (const it of raw) {
    if (!it || typeof it !== 'object') return { error: 'Cada ítem debe ser un objeto' };
    if (typeof it.idProducto !== 'string' || !UUID_RE.test(it.idProducto)) {
      return { error: 'Cada ítem debe tener un idProducto válido' };
    }
    if (!Number.isInteger(it.cantidad) || it.cantidad <= 0) {
      return { error: 'La cantidad de cada ítem debe ser un entero mayor a 0' };
    }
  }
  return { value: raw.map((it) => ({ id_producto: it.idProducto.toLowerCase(), cantidad: it.cantidad })) };
}

function validarPagos(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Debe incluir al menos un método de pago' };
  for (const p of raw) {
    if (!p || typeof p !== 'object') return { error: 'Cada pago debe ser un objeto' };
    if (!METODOS.includes(p.metodo)) {
      return { error: `El método de cada pago debe ser uno de: ${METODOS.join(', ')}` };
    }
    const s = typeof p.monto === 'number' ? String(p.monto) : typeof p.monto === 'string' ? p.monto.trim() : null;
    if (s === null || !/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
      return { error: 'El monto de cada pago debe ser un número positivo con hasta 2 decimales' };
    }
  }
  return { value: raw.map((p) => ({ metodo: p.metodo, monto: Number(p.monto) })) };
}

async function create(req, res) {
  try {
    const errors = {};
    const items = validarItems(req.body?.items);
    if (items.error) errors.items = items.error;
    const pagos = validarPagos(req.body?.pagos);
    if (pagos.error) errors.pagos = pagos.error;

    let idCliente;
    if (req.body?.idCliente !== undefined && req.body.idCliente !== null) {
      if (typeof req.body.idCliente !== 'string' || !UUID_RE.test(req.body.idCliente)) {
        errors.idCliente = 'El cliente no es válido';
      } else {
        idCliente = req.body.idCliente.toLowerCase();
      }
    }
    if (Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    const item = await venta.create({
      id_usuario: req.user.id, id_cliente: idCliente, items: items.value, pagos: pagos.value,
    });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.message === 'PRODUCTO_NO_ENCONTRADO') return res.status(404).json({ message: 'Producto no encontrado' });
    if (err.message === 'PRODUCTO_INACTIVO') {
      return res.status(409).json({ message: 'Hay un producto inactivo en la venta' });
    }
    if (err.message === 'STOCK_INSUFICIENTE') {
      return res.status(409).json({ message: `Stock insuficiente para "${err.productoNombre}"`, productoId: err.productoId });
    }
    if (err.message === 'PAGOS_NO_COINCIDEN') {
      return V.sendValidationError(res, { pagos: 'La suma de los pagos debe ser igual al total de la venta' });
    }
    console.error('venta.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const anularSchema = { motivo: V.texto('El motivo', { required: true, max: 300 }) };

async function anular(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, anularSchema);
    if (!ok) return V.sendValidationError(res, errors);

    const item = await venta.anular({ id: req.params.id, usuario_id: req.user.id, motivo: v.motivo });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.message === 'VENTA_NO_ENCONTRADA') return res.status(404).json({ message: 'Venta no encontrada' });
    if (err.message === 'VENTA_YA_ANULADA') return res.status(409).json({ message: 'Esta venta ya fue anulada' });
    console.error('venta.anular error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const findAllSchema = {
  desde: V.fecha('Desde'),
  hasta: V.fecha('Hasta'),
  usuarioId: V.uuid('El empleado'),
  anuladas: V.enumOf('El filtro de anuladas', ['true', 'false']),
};

async function findAll(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, findAllSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const page = Number.parseInt(req.query.page, 10) || 1;
    const pageSize = Math.min(Number.parseInt(req.query.pageSize, 10) || 20, 100);
    const { rows, totalCount } = await venta.findAll({
      desde: v.desde, hasta: v.hasta, usuarioId: v.usuarioId, anuladas: v.anuladas,
      limit: pageSize, offset: (page - 1) * pageSize,
    });
    return res.json({ data: toCamelCase(rows), meta: { page, pageSize, total: totalCount } });
  } catch (err) {
    console.error('venta.findAll error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function getById(req, res) {
  try {
    const item = await venta.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Venta no encontrada' });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('venta.getById error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const reportesSchema = { desde: V.fecha('Desde'), hasta: V.fecha('Hasta') };

async function getReportes(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, reportesSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);
    const data = await venta.getReportes({ desde: v.desde, hasta: v.hasta });
    return res.json({ data: toCamelCase(data) });
  } catch (err) {
    console.error('venta.getReportes error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { create, anular, findAll, getById, getReportes };
