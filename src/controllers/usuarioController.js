const bcrypt = require('bcryptjs');
const usuario = require('../models/usuario');

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
    const data = await usuario.findAll();
    return res.json({ data: toCamelCase(data) });
  } catch (err) {
    console.error('usuario.getAll error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function create(req, res) {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password || !rol) {
      return res.status(400).json({ message: 'nombre, email, password y rol son requeridos' });
    }
    if (!['dueno', 'recepcion', 'profesor'].includes(rol)) {
      return res.status(400).json({ message: 'Rol inválido' });
    }
    const existente = await usuario.findByEmail(email);
    if (existente) return res.status(409).json({ message: 'Ya existe un usuario con ese email' });

    const password_hash = await bcrypt.hash(password, 10);
    const item = await usuario.create({ nombre, email, password_hash, rol });
    return res.status(201).json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('usuario.create error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function update(req, res) {
  try {
    const { nombre, email, rol } = req.body;
    if (rol && !['dueno', 'recepcion', 'profesor'].includes(rol)) {
      return res.status(400).json({ message: 'Rol inválido' });
    }
    const item = await usuario.update(req.params.id, { nombre, email, rol });
    if (!item) return res.status(404).json({ message: 'Usuario no encontrado' });
    return res.json({ data: toCamelCase(item) });
  } catch (err) {
    console.error('usuario.update error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function toggleActivo(req, res) {
  try {
    const existing = await usuario.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Usuario no encontrado' });

    if (req.params.id === req.user.id) {
      return res.status(403).json({ message: 'No podés desactivar tu propia cuenta' });
    }

    const { pool } = require('../config/db');
    const { rows: rolRows } = await pool.query('SELECT es_admin FROM roles WHERE id = $1', [existing.id_rol]);
    if (rolRows[0]?.es_admin && existing.activo) {
      const { rows } = await pool.query(`
        SELECT COUNT(*) AS total FROM usuarios u
        JOIN roles r ON r.id = u.id_rol
        WHERE r.es_admin = true AND u.activo = true
      `);
      if (Number(rows[0].total) <= 1) {
        return res.status(403).json({ message: 'No se puede desactivar al único Admin activo del sistema' });
      }
    }

    const result = await usuario.toggleActivo(req.params.id);
    return res.json({ data: toCamelCase(result) });
  } catch (err) {
    console.error('usuario.toggleActivo error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { getAll, create, update, toggleActivo };
