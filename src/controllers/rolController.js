const rol = require('../models/rol');
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

const MSG_ROL_DUP = 'Ya existe un rol con esa descripción';
const MSG_ROL_CON_USUARIOS = 'No se puede eliminar el rol porque tiene usuarios asignados';

const schema = {
  descripcion: V.nombre('La descripción del rol', { required: true }),
  permissions: V.listaStrings('Los permisos'),
};

// Devuelve un mensaje de error si algún permiso no existe en la tabla permisos.
async function permisosInexistentes(permissions) {
  if (!permissions || permissions.length === 0) return null;
  const validos = new Set(await rol.findAllPermisos());
  const malos = permissions.filter((p) => !validos.has(p));
  return malos.length > 0 ? `Permisos inexistentes: ${malos.join(', ')}` : null;
}

async function getAll(req, res) {
  try {
    const data = await rol.findAll();
    if (data.some((r) => r.es_admin)) {
      const todos = await rol.findAllPermisos();
      data.forEach((r) => { if (r.es_admin) r.permissions = todos; });
    }
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
    const { values: v, errors } = V.validate(req.body, schema);
    const permissions = v.permissions ?? [];
    if (!errors.permissions) {
      const msg = await permisosInexistentes(permissions);
      if (msg) errors.permissions = msg;
    }
    if (Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    const item = await rol.create({ descripcion: v.descripcion, permissions });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_ROL_DUP, { descripcion: MSG_ROL_DUP });
    console.error('rol.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function update(req, res) {
  try {
    const existing = await rol.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Rol no encontrado' });
    if (existing.es_admin) {
      return res.status(403).json({ message: 'El rol Admin no se puede modificar' });
    }

    const { values: v, errors } = V.validate(req.body, schema, { partial: true });
    if (!errors.permissions) {
      const msg = await permisosInexistentes(v.permissions);
      if (msg) errors.permissions = msg;
    }
    if (Object.keys(errors).length > 0) return V.sendValidationError(res, errors);

    // permissions: null (vaciar) equivale a lista vacía; undefined (no enviado) no toca los permisos.
    const permissions = v.permissions === null ? [] : v.permissions;
    const item = await rol.update(req.params.id, { descripcion: v.descripcion, permissions });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_ROL_DUP, { descripcion: MSG_ROL_DUP });
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
    // assigned_count incluye usuarios inactivos, que también bloquean el borrado por FK.
    if (item.assigned_count > 0) {
      return res.status(409).json({ message: MSG_ROL_CON_USUARIOS });
    }
    await rol.remove(req.params.id);
    return res.json({ message: 'Rol eliminado correctamente', success: true });
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ message: MSG_ROL_CON_USUARIOS });
    console.error('rol.remove error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getAll, getPermisosDisponibles, create, update, remove };
