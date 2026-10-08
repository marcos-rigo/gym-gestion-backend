const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token no provisto' });
  }

  const token = header.slice('Bearer '.length);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido o expirado' });
  }
}

// Gate de gestión de usuarios: Admin o rol "Dueño". Además adjunta req.user.es_admin.
async function requireDueno(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT r.es_admin, r.descripcion, u.activo FROM usuarios u
       JOIN roles r ON r.id = u.id_rol
       WHERE u.id = $1`,
      [req.user.id]
    );
    const rol = rows[0];
    if (!rol || !rol.activo) return res.status(401).json({ message: 'Usuario no encontrado o inactivo' });
    if (!rol.es_admin && rol.descripcion !== 'Dueño') {
      return res.status(403).json({ message: 'Acceso denegado: requiere rol de Dueño' });
    }
    req.user.es_admin = rol.es_admin;
    next();
  } catch (err) {
    console.error('requireDueno error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

// Debe correr después de `auth`. Rechaza usuarios borrados o desactivados aunque su token siga vigente.
async function cargarRol(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT id_rol, activo FROM usuarios WHERE id = $1', [req.user.id]);
    if (!rows[0] || !rows[0].activo) {
      return res.status(401).json({ message: 'Usuario no encontrado o inactivo' });
    }
    req.user.id_rol = rows[0].id_rol;
    next();
  } catch (err) {
    console.error('cargarRol error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = auth;
module.exports.requireDueno = requireDueno;
module.exports.cargarRol = cargarRol;
