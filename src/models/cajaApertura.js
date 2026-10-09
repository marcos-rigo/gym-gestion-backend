const { pool } = require('../config/db');

async function findByFecha(fecha) {
  const { rows } = await pool.query(
    `SELECT ca.*, u.nombre AS usuario_nombre FROM caja_apertura ca
     LEFT JOIN usuarios u ON u.id = ca.id_usuario WHERE ca.fecha = $1`,
    [fecha]
  );
  return rows[0] ?? null;
}

// Upsert por fecha (una apertura por día; si ya existe, se actualiza el monto inicial).
async function upsert({ fecha, monto_inicial_efectivo, usuario_id }) {
  await pool.query(
    `INSERT INTO caja_apertura (fecha, monto_inicial_efectivo, id_usuario)
     VALUES ($1,$2,$3)
     ON CONFLICT (fecha) DO UPDATE SET
       monto_inicial_efectivo = EXCLUDED.monto_inicial_efectivo,
       id_usuario = EXCLUDED.id_usuario,
       updated_at = now()`,
    [fecha, monto_inicial_efectivo, usuario_id]
  );
  return findByFecha(fecha);
}

module.exports = { findByFecha, upsert };
