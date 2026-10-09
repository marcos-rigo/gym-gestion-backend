const cliente = require('../models/cliente');
const V = require('../utils/validators');
const { hoyISO, addDays, PERIODO_DIAS } = require('../config/fechas');

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

const MSG_DNI_DUP = 'Ya existe un cliente con ese DNI';
const MSG_VENC = 'El vencimiento no puede ser anterior al inicio de la cuota';

const schema = {
  nombre: V.nombre('El nombre', { required: true }),
  apellido: V.nombre('El apellido', { required: true }),
  dni: V.dni({ required: true }),
  fechaNacimiento: V.fechaNacimiento(),
  telefono: V.telefono(),
  email: V.email(),
  direccion: V.texto('La dirección', { max: 200 }),
  fotoUrl: V.url('La foto'),
  contactoEmergencia: V.texto('El contacto de emergencia', { max: 100 }),
  observaciones: V.texto('Las observaciones', { max: 500 }),
  // Puede ser retroactiva (clientes que ya venían antes de cargarse en el sistema), nunca futura.
  fechaAlta: V.fechaNoFutura('La fecha de alta'),
  fechaInicioCuota: V.fecha('La fecha de inicio de cuota'),
  fechaVencimiento: V.fecha('La fecha de vencimiento'),
};
const updateSchema = { ...schema, estado: V.enumOf('El estado', ['activo', 'vencido', 'suspendido']) };

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
    const { values: v, errors } = V.validate(req.body, schema);
    const fechaInicio = v.fechaInicioCuota || hoyISO();
    const fechaVenc = v.fechaVencimiento || addDays(fechaInicio, PERIODO_DIAS);
    if (!errors.fechaInicioCuota && !errors.fechaVencimiento && fechaVenc < fechaInicio) {
      errors.fechaVencimiento = MSG_VENC;
    }
    if (Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    if (await cliente.findByDNI(v.dni)) {
      return V.sendConflict(res, MSG_DNI_DUP, { dni: MSG_DNI_DUP });
    }

    const item = await cliente.create({
      nombre: v.nombre, apellido: v.apellido, dni: v.dni,
      fecha_nacimiento: v.fechaNacimiento,
      telefono: v.telefono,
      email: v.email,
      direccion: v.direccion,
      foto_url: v.fotoUrl,
      contacto_emergencia: v.contactoEmergencia,
      observaciones: v.observaciones,
      fecha_alta: v.fechaAlta || hoyISO(),
      fecha_inicio_cuota: fechaInicio,
      fecha_vencimiento: fechaVenc,
    });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_DNI_DUP, { dni: MSG_DNI_DUP });
    console.error('cliente.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function update(req, res) {
  try {
    const existing = await cliente.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Cliente no encontrado' });

    // Los campos no enviados conservan su valor actual; null/'' en un campo opcional lo vacía.
    const { values: v, errors } = V.validate(req.body, updateSchema, { partial: true });
    const pick = (key, col) => (v[key] !== undefined ? v[key] : existing[col]);
    // Las fechas de alta y de cuota son NOT NULL: si llegan vacías se conserva la actual.
    const fechaAlta = v.fechaAlta ?? existing.fecha_alta;
    const fechaInicio = v.fechaInicioCuota ?? existing.fecha_inicio_cuota;
    const fechaVenc = v.fechaVencimiento ?? existing.fecha_vencimiento;
    if (!errors.fechaInicioCuota && !errors.fechaVencimiento && fechaVenc < fechaInicio) {
      errors.fechaVencimiento = MSG_VENC;
    }
    if (Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    if (v.dni && v.dni !== existing.dni) {
      const otro = await cliente.findByDNI(v.dni);
      if (otro && otro.id !== existing.id) return V.sendConflict(res, MSG_DNI_DUP, { dni: MSG_DNI_DUP });
    }

    const item = await cliente.update(req.params.id, {
      nombre: pick('nombre', 'nombre'),
      apellido: pick('apellido', 'apellido'),
      dni: pick('dni', 'dni'),
      fecha_nacimiento: pick('fechaNacimiento', 'fecha_nacimiento'),
      telefono: pick('telefono', 'telefono'),
      email: pick('email', 'email'),
      direccion: pick('direccion', 'direccion'),
      foto_url: pick('fotoUrl', 'foto_url'),
      contacto_emergencia: pick('contactoEmergencia', 'contacto_emergencia'),
      observaciones: pick('observaciones', 'observaciones'),
      fecha_alta: fechaAlta,
      fecha_inicio_cuota: fechaInicio,
      fecha_vencimiento: fechaVenc,
      estado: v.estado ?? existing.estado,
    });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_DNI_DUP, { dni: MSG_DNI_DUP });
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

const listadoSchema = { query: V.texto('La búsqueda', { max: 100 }) };

function paginacion(req) {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const pageSize = Math.min(Number.parseInt(req.query.pageSize, 10) || 20, 100);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function getMorosos(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, listadoSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);
    const { page, pageSize, offset } = paginacion(req);

    const { rows, totalCount, totalAdeudado } = await cliente.findMorosos({
      query: v.query, limit: pageSize, offset,
    });
    return res.json({
      data: toCamelCase(rows),
      meta: { page, pageSize, total: totalCount, totalAdeudado },
    });
  } catch (err) {
    console.error('cliente.getMorosos error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function getPorVencer(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, listadoSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);
    const { page, pageSize, offset } = paginacion(req);

    const { rows, totalCount, proyeccionIngresos } = await cliente.findPorVencer({
      query: v.query, limit: pageSize, offset,
    });
    return res.json({
      data: toCamelCase(rows),
      meta: { page, pageSize, total: totalCount, proyeccionIngresos },
    });
  } catch (err) {
    console.error('cliente.getPorVencer error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getAll, getById, create, update, remove, getMorosos, getPorVencer };
