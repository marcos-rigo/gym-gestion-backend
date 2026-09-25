const rol = require('../models/rol');

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

async function getAll(req, res) {
  try {
    const data = await rol.findAll();
    return res.json({ data: toCamelCase(data) });
  } catch (err) {
    console.error('rol.getAll error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function getPermisosDisponibles(req, res) {
  try {
    const data = await rol.findAllPermisos();
    return res.json({ data });
  } catch (err) {
    console.error('rol.getPermisosDisponibles error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function create(req, res) {
  try {
    const { descripcion, permissions = [] } = req.body;
    if (!descripcion) return res.status(400).json({ message: 'descripcion es requerida' });
    const item = await rol.create({ descripcion, permissions });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('rol.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function update(req, res) {
  try {
    const existing = await rol.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Rol no encontrado' });
    const { permissions, ...cambios } = req.body;
    const item = await rol.update(req.params.id, existing.es_admin ? cambios : req.body);
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('rol.update error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function remove(req, res) {
  try {
    const item = await rol.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Rol no encontrado' });
    if (item.es_admin) {
      return res.status(403).json({ message: 'El rol Admin no se puede eliminar' });
    }
    if (item.user_count > 0) {
      return res.status(409).json({ message: 'No se puede eliminar el rol porque tiene usuarios asignados' });
    }
    await rol.remove(req.params.id);
    return res.json({ message: 'Rol eliminado correctamente', success: true });
  } catch (err) {
    console.error('rol.remove error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getAll, getPermisosDisponibles, create, update, remove };
