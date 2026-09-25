const { pool } = require('../config/db');

function checkPermiso(permisoRequerido) {
  return async (req, res, next) => {
    try {
      const { rows: rolRows } = await pool.query(
        'SELECT es_admin FROM roles WHERE id = $1', [req.user.id_rol]
      );
      if (rolRows[0]?.es_admin) return next(); // Admin pasa cualquier chequeo de permiso

      const { rows } = await pool.query(`
        SELECT 1 FROM linea_permiso lp
        JOIN permisos p ON p.id = lp.id_permiso
        WHERE lp.id_rol = $1 AND p.descripcion = $2
        LIMIT 1
      `, [req.user.id_rol, permisoRequerido]);

      if (rows.length === 0) {
        return res.status(403).json({ message: `No tenés el permiso requerido: ${permisoRequerido}` });
      }
      next();
    } catch (err) {
      console.error('checkPermiso error:', err);
      return res.status(500).json({ message: 'Error interno del servidor' });
    }
  };
}

module.exports = checkPermiso;
