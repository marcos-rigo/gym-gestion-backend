const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token no provisto' });
  }

  const token = header.slice('Bearer '.length);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido o expirado' });
  }
}

function requireDueno(req, res, next) {
  if (req.user?.rol !== 'dueno') {
    return res.status(403).json({ message: 'Acceso denegado: requiere rol de Dueño' });
  }
  next();
}

async function cargarRol(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT id_rol FROM usuarios WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(401).json({ message: 'Usuario no encontrado' });
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
