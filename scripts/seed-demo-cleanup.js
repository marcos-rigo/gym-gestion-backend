// Borra todo lo generado por scripts/seed-demo.js (ver las marcas documentadas ahí).
//
// Uso:
//   node scripts/seed-demo-cleanup.js --dry-run   → solo cuenta lo que se borraría
//   node scripts/seed-demo-cleanup.js             → borra (en una transacción)
//
// - Datos reales cargados después sobre clientes demo: los pagos se borran con el cliente (cascade);
//   las ventas reales que referencian a un cliente demo se conservan con id_cliente = NULL.
// - Un producto creado por el seed solo se borra si ya no lo referencia ninguna venta/movimiento real.

require('dotenv').config({ quiet: true });
const { ES_DNI_DEMO, ES_CIERRE_DEMO, esDemoTs } = require('./seed-demo');

const CLIENTES_DEMO = `SELECT id FROM clientes WHERE ${ES_DNI_DEMO}`;
const VENTAS_DEMO = `SELECT id FROM ventas WHERE ${esDemoTs('fecha_hora')}`;
const PRODUCTOS_DEMO = `SELECT id FROM productos WHERE ${esDemoTs('created_at')}`;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL en .env');
  const { pool, withTransaction } = require('../src/config/db');

  try {
    const { rows: [c] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM clientes WHERE ${ES_DNI_DEMO})::int AS clientes,
        (SELECT COUNT(*) FROM pagos WHERE cliente_id IN (${CLIENTES_DEMO}))::int AS pagos,
        (SELECT COUNT(*) FROM ventas WHERE ${esDemoTs('fecha_hora')})::int AS ventas,
        (SELECT COUNT(*) FROM ventas WHERE id_cliente IN (${CLIENTES_DEMO}) AND NOT ${esDemoTs('fecha_hora')})::int AS ventas_reales_a_desvincular,
        (SELECT COUNT(*) FROM movimientos_stock WHERE id_venta IN (${VENTAS_DEMO})
           OR (id_producto IN (${PRODUCTOS_DEMO}) AND ${esDemoTs('fecha_hora')}))::int AS movimientos_stock,
        (SELECT COUNT(*) FROM movimientos_caja WHERE ${esDemoTs('fecha_hora')})::int AS movimientos_caja,
        (SELECT COUNT(*) FROM cierre_caja WHERE ${ES_CIERRE_DEMO})::int AS cierres,
        (SELECT COUNT(*) FROM productos WHERE ${esDemoTs('created_at')})::int AS productos`);
    console.log(`${dryRun ? 'Se borraría' : 'A borrar'}:`, c);
    if (dryRun) return;

    const conservados = await withTransaction(async (client) => {
      await client.query(`UPDATE ventas SET id_cliente = NULL
        WHERE id_cliente IN (${CLIENTES_DEMO}) AND NOT ${esDemoTs('fecha_hora')}`);
      await client.query(`DELETE FROM movimientos_stock WHERE id_venta IN (${VENTAS_DEMO})
        OR (id_producto IN (${PRODUCTOS_DEMO}) AND ${esDemoTs('fecha_hora')})`);
      await client.query(`DELETE FROM ventas WHERE ${esDemoTs('fecha_hora')}`); // cascade: venta_items, venta_pagos
      await client.query(`DELETE FROM movimientos_caja WHERE ${esDemoTs('fecha_hora')}`);
      await client.query(`DELETE FROM cierre_caja WHERE ${ES_CIERRE_DEMO}`);
      await client.query(`DELETE FROM clientes WHERE ${ES_DNI_DEMO}`); // cascade: pagos, pago_metodos
      await client.query(`DELETE FROM productos p WHERE ${esDemoTs('p.created_at')}
        AND NOT EXISTS (SELECT 1 FROM venta_items vi WHERE vi.id_producto = p.id)
        AND NOT EXISTS (SELECT 1 FROM movimientos_stock ms WHERE ms.id_producto = p.id)`);
      const { rows } = await client.query(`SELECT nombre FROM productos WHERE ${esDemoTs('created_at')}`);
      return rows.map((r) => r.nombre);
    });

    console.log('Listo: datos del seed demo eliminados.');
    if (conservados.length) {
      console.log(`Productos conservados porque ya tienen ventas/movimientos reales: ${conservados.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error en el cleanup (no se borró nada, la transacción se revirtió):', err.message);
  process.exitCode = 1;
});
