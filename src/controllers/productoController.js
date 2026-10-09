const producto = require('../models/producto');
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

const MSG_NOMBRE_DUP = 'Ya existe un producto con ese nombre';

const schema = {
  nombre: V.nombreProducto('El nombre', { required: true }),
  descripcion: V.texto('La descripción', { max: 200 }),
  categoria: V.texto('La categoría', { max: 50 }),
  precio: V.monto({ required: true }),
  controlaStock: V.enumOf('Controla stock', [true, false]),
  stockActual: V.entero('El stock actual', { min: 0 }),
  stockMinimo: V.entero('El stock mínimo', { min: 0 }),
};

// controlaStock no viaja siempre con tipo boolean estricto desde JSON si el cliente manda
// string; V.enumOf exige igualdad estricta así que se normaliza antes de validar.
function normalizarBooleanos(body) {
  if (typeof body?.controlaStock === 'string') {
    return { ...body, controlaStock: body.controlaStock === 'true' };
  }
  return body;
}

async function getAll(req, res) {
  try {
    const listadoSchema = {
      query: V.texto('La búsqueda', { max: 100 }),
      activo: V.enumOf('El filtro de activo', ['true', 'false']),
    };
    const { ok, values: v, errors } = V.validate(req.query, listadoSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const page = Number.parseInt(req.query.page, 10) || 1;
    const pageSize = Math.min(Number.parseInt(req.query.pageSize, 10) || 20, 100);
    const activo = v.activo === undefined ? undefined : v.activo === 'true';

    const { rows, totalCount } = await producto.findAll({
      query: v.query, activo, limit: pageSize, offset: (page - 1) * pageSize,
    });
    return res.json({ data: toCamelCase(rows), meta: { page, pageSize, total: totalCount } });
  } catch (err) {
    console.error('producto.getAll error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function getById(req, res) {
  try {
    const item = await producto.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Producto no encontrado' });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('producto.getById error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function create(req, res) {
  try {
    const { values: v, errors } = V.validate(normalizarBooleanos(req.body), schema);
    const controlaStock = v.controlaStock ?? false;
    if (controlaStock && !errors.stockActual && v.stockActual === undefined) v.stockActual = 0;
    if (Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    if (await producto.findByNombre(v.nombre)) {
      return V.sendConflict(res, MSG_NOMBRE_DUP, { nombre: MSG_NOMBRE_DUP });
    }

    const item = await producto.create({
      nombre: v.nombre, descripcion: v.descripcion, categoria: v.categoria, precio: v.precio,
      controla_stock: controlaStock, stock_actual: v.stockActual, stock_minimo: v.stockMinimo,
    });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_NOMBRE_DUP, { nombre: MSG_NOMBRE_DUP });
    console.error('producto.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function update(req, res) {
  try {
    const existing = await producto.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Producto no encontrado' });

    const { values: v, errors } = V.validate(normalizarBooleanos(req.body), schema, { partial: true });
    if (Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    if (v.nombre && v.nombre.toLowerCase() !== existing.nombre.toLowerCase()) {
      const otro = await producto.findByNombre(v.nombre);
      if (otro && otro.id !== existing.id) return V.sendConflict(res, MSG_NOMBRE_DUP, { nombre: MSG_NOMBRE_DUP });
    }

    const controlaStock = v.controlaStock ?? existing.controla_stock;
    const item = await producto.update(req.params.id, {
      nombre: v.nombre ?? existing.nombre,
      descripcion: v.descripcion !== undefined ? v.descripcion : existing.descripcion,
      categoria: v.categoria !== undefined ? v.categoria : existing.categoria,
      precio: v.precio ?? existing.precio,
      controla_stock: controlaStock,
      stock_actual: v.stockActual !== undefined ? v.stockActual : (existing.stock_actual ?? (controlaStock ? 0 : null)),
      stock_minimo: v.stockMinimo !== undefined ? v.stockMinimo : existing.stock_minimo,
    });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_NOMBRE_DUP, { nombre: MSG_NOMBRE_DUP });
    console.error('producto.update error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

// "Eliminar" un producto = desactivarlo. toggleActivo también permite reactivarlo.
async function toggleActivo(req, res) {
  try {
    const existing = await producto.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Producto no encontrado' });
    const item = await producto.toggleActivo(req.params.id, !existing.activo);
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('producto.toggleActivo error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function remove(req, res) {
  try {
    const existing = await producto.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Producto no encontrado' });
    const item = await producto.toggleActivo(req.params.id, false);
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('producto.remove error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

const ajusteSchema = {
  delta: V.entero('El ajuste', { required: true }),
  motivo: V.texto('El motivo', { max: 300 }),
};

async function ajustarStock(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, ajusteSchema);
    if (ok && v.delta === 0) errors.delta = 'El ajuste no puede ser 0';
    if (!ok || errors.delta) return V.sendValidationError(res, errors);

    const item = await producto.ajustarStock({ id: req.params.id, delta: v.delta, usuario_id: req.user.id });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.message === 'PRODUCTO_NO_ENCONTRADO') return res.status(404).json({ message: 'Producto no encontrado' });
    if (err.message === 'PRODUCTO_NO_CONTROLA_STOCK') {
      return res.status(409).json({ message: 'Este producto no controla stock' });
    }
    if (err.message === 'STOCK_INSUFICIENTE') {
      return res.status(409).json({ message: 'El ajuste dejaría el stock en negativo' });
    }
    console.error('producto.ajustarStock error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getAll, getById, create, update, toggleActivo, remove, ajustarStock };
