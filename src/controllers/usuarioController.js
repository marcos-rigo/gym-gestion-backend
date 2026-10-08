const bcrypt = require('bcryptjs');
const usuario = require('../models/usuario');
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

const MSG_EMAIL_DUP = 'Ya existe un usuario con ese email';
const MSG_SOLO_ADMIN = 'Solo un Admin puede gestionar usuarios con rol Admin';

const createSchema = {
  nombre: V.nombre('El nombre', { required: true }),
  email: V.email({ required: true }),
  password: V.password({ required: true }),
  idRol: V.uuid('El rol', { required: true }),
};
const updateSchema = {
  nombre: createSchema.nombre,
  email: createSchema.email,
  idRol: createSchema.idRol,
};

// Un "Dueño" (no Admin) no puede crear/asignar/modificar usuarios Admin: evita escalar privilegios.
// `req.user.es_admin` lo carga el middleware requireDueno.
function bloqueadoPorNoAdmin(req, existing) {
  return !req.user.es_admin && existing?.es_admin;
}

async function getAll(req, res) {
  try {
    const data = await usuario.findAll();
    return res.json({ data: toCamelCase(data) });
  } catch (err) {
    console.error('usuario.getAll error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function create(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, createSchema);
    if (!ok) return V.sendValidationError(res, errors);

    const rolDestino = await rol.findBasicById(v.idRol);
    if (!rolDestino) return V.sendValidationError(res, { idRol: 'El rol seleccionado no existe' }, 'Rol inválido');
    if (!req.user.es_admin && rolDestino.es_admin) {
      return res.status(403).json({ message: MSG_SOLO_ADMIN });
    }

    if (await usuario.emailEnUso(v.email)) {
      return V.sendConflict(res, MSG_EMAIL_DUP, { email: MSG_EMAIL_DUP });
    }

    const password_hash = await bcrypt.hash(v.password, 10);
    const item = await usuario.create({ nombre: v.nombre, email: v.email, password_hash, id_rol: v.idRol });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_EMAIL_DUP, { email: MSG_EMAIL_DUP });
    console.error('usuario.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function update(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.body, updateSchema);
    if (!ok) return V.sendValidationError(res, errors);

    const existing = await usuario.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (existing.protegido) {
      return res.status(403).json({ message: 'Este usuario está protegido y no puede ser modificado' });
    }
    if (bloqueadoPorNoAdmin(req, existing)) return res.status(403).json({ message: MSG_SOLO_ADMIN });

    const rolDestino = await rol.findBasicById(v.idRol);
    if (!rolDestino) return V.sendValidationError(res, { idRol: 'El rol seleccionado no existe' }, 'Rol inválido');
    if (!req.user.es_admin && rolDestino.es_admin) {
      return res.status(403).json({ message: MSG_SOLO_ADMIN });
    }

    if (await usuario.emailEnUso(v.email, req.params.id)) {
      return V.sendConflict(res, MSG_EMAIL_DUP, { email: MSG_EMAIL_DUP });
    }

    // No dejar al sistema sin ningún Admin activo.
    if (existing.es_admin && existing.activo && !rolDestino.es_admin) {
      if (await usuario.countAdminsActivos() <= 1) {
        return res.status(403).json({ message: 'No se puede quitar el rol al único Admin activo del sistema' });
      }
    }

    const item = await usuario.update(req.params.id, { nombre: v.nombre, email: v.email, id_rol: v.idRol });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    if (err.code === '23505') return V.sendConflict(res, MSG_EMAIL_DUP, { email: MSG_EMAIL_DUP });
    console.error('usuario.update error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function toggleActivo(req, res) {
  try {
    const existing = await usuario.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (existing.protegido) {
      return res.status(403).json({ message: 'Este usuario está protegido y no puede ser desactivado' });
    }
    if (bloqueadoPorNoAdmin(req, existing)) return res.status(403).json({ message: MSG_SOLO_ADMIN });

    if (req.params.id === req.user.id) {
      return res.status(403).json({ message: 'No podés desactivar tu propia cuenta' });
    }

    if (existing.es_admin && existing.activo && await usuario.countAdminsActivos() <= 1) {
      return res.status(403).json({ message: 'No se puede desactivar al único Admin activo del sistema' });
    }

    const result = await usuario.toggleActivo(req.params.id);
    return res.json({ data: toCamelCase(result) });
  } catch (err) {
    console.error('usuario.toggleActivo error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function remove(req, res) {
  try {
    const existing = await usuario.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (existing.protegido) {
      return res.status(403).json({ message: 'Este usuario está protegido y no puede ser eliminado' });
    }
    if (bloqueadoPorNoAdmin(req, existing)) return res.status(403).json({ message: MSG_SOLO_ADMIN });
    if (req.params.id === req.user.id) {
      return res.status(403).json({ message: 'No podés eliminar tu propia cuenta' });
    }
    if (existing.es_admin && existing.activo && await usuario.countAdminsActivos() <= 1) {
      return res.status(403).json({ message: 'No se puede eliminar al único Admin activo del sistema' });
    }

    await usuario.remove(req.params.id);
    return res.json({ message: 'Usuario eliminado correctamente', success: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({
        message: 'No se puede eliminar: el usuario tiene pagos registrados. Desactivalo en su lugar.',
      });
    }
    console.error('usuario.remove error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getAll, create, update, toggleActivo, remove };
