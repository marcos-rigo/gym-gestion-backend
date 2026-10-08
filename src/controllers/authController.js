const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const usuario = require('../models/usuario');
const rol = require('../models/rol');

async function login(req, res) {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return res.status(400).json({ message: 'Email y contraseña requeridos' });
    }

    const user = await usuario.findByEmail(email.trim());
    if (!user) return res.status(401).json({ message: 'Credenciales inválidas' });

    const valido = await bcrypt.compare(password, user.password_hash);
    if (!valido) return res.status(401).json({ message: 'Credenciales inválidas' });

    const payload = { id: user.id, nombre: user.nombre, email: user.email };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

    return res.json({ token, usuario: payload });
  } catch (err) {
    console.error('auth.login error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

async function misPermisos(req, res) {
  try {
    const rolData = await rol.findById(req.user.id_rol);
    if (!rolData) return res.status(404).json({ message: 'Rol no encontrado' });

    let permissions = rolData.permissions;
    if (rolData.es_admin) {
      permissions = await rol.findAllPermisos(); // todos los permisos existentes
    }

    return res.json({
      data: { idRol: rolData.id, descripcion: rolData.descripcion, esAdmin: rolData.es_admin, permissions }
    });
  } catch (err) {
    console.error('misPermisos error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { login, misPermisos };
