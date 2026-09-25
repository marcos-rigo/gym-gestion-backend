const cliente = require('../models/cliente');

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
    const data = await cliente.findAll();
    return res.json({ data: toCamelCase(data) });
  } catch (err) {
    console.error('cliente.getAll error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function getById(req, res) {
  try {
    const item = await cliente.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Cliente no encontrado' });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('cliente.getById error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function create(req, res) {
  try {
    const { nombre, apellido, dni } = req.body;
    if (!nombre || !apellido || !dni) {
      return res.status(400).json({ message: 'nombre, apellido y dni son requeridos' });
    }
    const existente = await cliente.findByDNI(dni);
    if (existente) return res.status(409).json({ message: 'Ya existe un cliente con ese DNI' });

    const fechaInicio = req.body.fechaInicioCuota || new Date().toISOString().slice(0, 10);
    const fechaVenc = req.body.fechaVencimiento ||
      new Date(new Date(fechaInicio).getTime() + 30 * 86400000).toISOString().slice(0, 10);

    const item = await cliente.create({
      nombre, apellido, dni,
      fecha_nacimiento: req.body.fechaNacimiento,
      telefono: req.body.telefono,
      email: req.body.email,
      direccion: req.body.direccion,
      foto_url: req.body.fotoUrl,
      contacto_emergencia: req.body.contactoEmergencia,
      observaciones: req.body.observaciones,
      fecha_inicio_cuota: fechaInicio,
      fecha_vencimiento: fechaVenc,
    });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('cliente.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function update(req, res) {
  try {
    const existing = await cliente.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Cliente no encontrado' });

    const item = await cliente.update(req.params.id, {
      nombre: req.body.nombre,
      apellido: req.body.apellido,
      dni: req.body.dni,
      fecha_nacimiento: req.body.fechaNacimiento,
      telefono: req.body.telefono,
      email: req.body.email,
      direccion: req.body.direccion,
      foto_url: req.body.fotoUrl,
      contacto_emergencia: req.body.contactoEmergencia,
      observaciones: req.body.observaciones,
      fecha_inicio_cuota: req.body.fechaInicioCuota ?? existing.fecha_inicio_cuota,
      fecha_vencimiento: req.body.fechaVencimiento ?? existing.fecha_vencimiento,
      estado: req.body.estado ?? existing.estado,
    });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('cliente.update error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function remove(req, res) {
  try {
    const deleted = await cliente.remove(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Cliente no encontrado' });
    return res.json({ message: 'Cliente eliminado correctamente', success: true });
  } catch (err) {
    console.error('cliente.remove error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getAll, getById, create, update, remove };
