const { pool, withTransaction } = require('../config/db');
const { TZ, HOY_SQL } = require('../config/fechas');

const SELECT_ITEMS_SQL = `
  SELECT id, id_producto, nombre_snapshot, precio_unitario, cantidad, subtotal
  FROM venta_items WHERE id_venta = $1 ORDER BY id`;
const SELECT_PAGOS_SQL = `
  SELECT id, metodo, monto FROM venta_pagos WHERE id_venta = $1 ORDER BY id`;

async function attachDetalle(venta) {
  if (!venta) return null;
  const [items, pagos] = await Promise.all([
    pool.query(SELECT_ITEMS_SQL, [venta.id]),
    pool.query(SELECT_PAGOS_SQL, [venta.id]),
  ]);
  return { ...venta, items: items.rows, pagos: pagos.rows };
}

// Mismo SELECT (venta + nombre de usuario/cliente) para findById y findAll: antes findById
// no traía estos dos campos y findAll sí, así que un detalle de venta y una fila del listado
// tenían shapes distintos para el mismo tipo de objeto.
const SELECT_VENTA_CON_NOMBRES = `
  SELECT v.*, u.nombre AS usuario_nombre, c.apellido || ', ' || c.nombre AS cliente_nombre_completo
  FROM ventas v
  LEFT JOIN usuarios u ON u.id = v.id_usuario
  LEFT JOIN clientes c ON c.id = v.id_cliente`;

async function findById(id) {
  const { rows } = await pool.query(`${SELECT_VENTA_CON_NOMBRES} WHERE v.id = $1`, [id]);
  return attachDetalle(rows[0] ?? null);
}

// Registra la venta de forma atómica: valida productos activos, calcula el total con el
// precio del servidor (nunca el del cliente), descuenta stock solo si controla_stock
// (409 si no alcanza), y exige que la suma de `pagos` sea exactamente igual al total.
async function create({ id_usuario, id_cliente, items, pagos }) {
  const ventaId = await withTransaction(async (client) => {
    const detalleItems = [];
    let total = 0;

    for (const { id_producto, cantidad } of items) {
      const { rows } = await client.query('SELECT * FROM productos WHERE id = $1 FOR UPDATE', [id_producto]);
      const prod = rows[0];
      if (!prod) throw new Error('PRODUCTO_NO_ENCONTRADO');
      if (!prod.activo) throw new Error('PRODUCTO_INACTIVO');

      if (prod.controla_stock && prod.stock_actual < cantidad) {
        const err = new Error('STOCK_INSUFICIENTE');
        err.productoId = prod.id;
        err.productoNombre = prod.nombre;
        throw err;
      }

      const subtotal = Number(prod.precio) * cantidad;
      total += subtotal;
      detalleItems.push({
        id_producto: prod.id, nombre_snapshot: prod.nombre,
        precio_unitario: prod.precio, cantidad, subtotal, controla_stock: prod.controla_stock,
      });
    }
    total = Math.round(total * 100) / 100;

    const sumaPagos = Math.round(pagos.reduce((acc, p) => acc + Number(p.monto), 0) * 100) / 100;
    if (sumaPagos !== total) throw new Error('PAGOS_NO_COINCIDEN');

    const { rows: ventaRows } = await client.query(
      `INSERT INTO ventas (id_usuario, id_cliente, total) VALUES ($1,$2,$3) RETURNING id`,
      [id_usuario, id_cliente ?? null, total]
    );
    const ventaId = ventaRows[0].id;

    for (const it of detalleItems) {
      await client.query(
        `INSERT INTO venta_items (id_venta, id_producto, nombre_snapshot, precio_unitario, cantidad, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ventaId, it.id_producto, it.nombre_snapshot, it.precio_unitario, it.cantidad, it.subtotal]
      );
      if (it.controla_stock) {
        await client.query('UPDATE productos SET stock_actual = stock_actual - $1, updated_at = now() WHERE id = $2',
          [it.cantidad, it.id_producto]);
        await client.query(
          `INSERT INTO movimientos_stock (id_producto, tipo, cantidad, id_venta, id_usuario)
           VALUES ($1,'venta',$2,$3,$4)`,
          [it.id_producto, -it.cantidad, ventaId, id_usuario]
        );
      }
    }

    for (const p of pagos) {
      await client.query(
        'INSERT INTO venta_pagos (id_venta, metodo, monto) VALUES ($1,$2,$3)',
        [ventaId, p.metodo, p.monto]
      );
    }

    return ventaId;
  });
  return findById(ventaId);
}

async function anular({ id, usuario_id, motivo }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM ventas WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new Error('VENTA_NO_ENCONTRADA');
    if (rows[0].anulada) throw new Error('VENTA_YA_ANULADA');

    const { rows: items } = await client.query(
      `SELECT vi.id_producto, vi.cantidad, p.controla_stock
       FROM venta_items vi JOIN productos p ON p.id = vi.id_producto
       WHERE vi.id_venta = $1`,
      [id]
    );
    for (const it of items) {
      if (!it.controla_stock) continue;
      await client.query('UPDATE productos SET stock_actual = stock_actual + $1, updated_at = now() WHERE id = $2',
        [it.cantidad, it.id_producto]);
      await client.query(
        `INSERT INTO movimientos_stock (id_producto, tipo, cantidad, id_venta, id_usuario)
         VALUES ($1,'anulacion_venta',$2,$3,$4)`,
        [it.id_producto, it.cantidad, id, usuario_id]
      );
    }

    await client.query(
      `UPDATE ventas SET anulada = true, anulada_at = now(), anulada_por = $2, motivo_anulacion = $3 WHERE id = $1`,
      [id, usuario_id, motivo]
    );
    return id;
  }).then(findById);
}

function buildFiltros({ desde, hasta, usuarioId, anuladas } = {}) {
  const where = ['1=1'];
  const params = [];
  const p = (value) => { params.push(value); return `$${params.length}`; };

  if (desde) where.push(`(v.fecha_hora AT TIME ZONE '${TZ}')::date >= ${p(desde)}`);
  if (hasta) where.push(`(v.fecha_hora AT TIME ZONE '${TZ}')::date <= ${p(hasta)}`);
  if (usuarioId) where.push(`v.id_usuario = ${p(usuarioId)}`);
  if (anuladas === 'true') where.push('v.anulada = true');
  if (anuladas === 'false') where.push('v.anulada = false');

  return { whereSql: where.join(' AND '), params, p };
}

async function findAll({ limit = 50, offset = 0, ...filtros } = {}) {
  const { whereSql, params, p } = buildFiltros(filtros);
  const { rows } = await pool.query(`
    SELECT v.*, u.nombre AS usuario_nombre, c.apellido || ', ' || c.nombre AS cliente_nombre_completo,
      COUNT(*) OVER()::int AS total_count
    FROM ventas v
    LEFT JOIN usuarios u ON u.id = v.id_usuario
    LEFT JOIN clientes c ON c.id = v.id_cliente
    WHERE ${whereSql}
    ORDER BY v.fecha_hora DESC
    LIMIT ${p(limit)} OFFSET ${p(offset)}
  `, params);

  const ventas = await Promise.all(rows.map(async ({ total_count, ...v }) => attachDetalle(v)));
  return { rows: ventas, totalCount: rows[0]?.total_count ?? 0 };
}

// Unidades/ingreso por producto y ventas por día, en el rango [desde, hasta] (fechas locales).
// Excluye ventas anuladas.
async function getReportes({ desde, hasta } = {}) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['v.anulada = false'];
  if (desde) where.push(`(v.fecha_hora AT TIME ZONE '${TZ}')::date >= ${p(desde)}`);
  if (hasta) where.push(`(v.fecha_hora AT TIME ZONE '${TZ}')::date <= ${p(hasta)}`);
  const whereSql = where.join(' AND ');

  const [porProducto, porDia] = await Promise.all([
    pool.query(`
      SELECT vi.id_producto, vi.nombre_snapshot,
        SUM(vi.cantidad)::int AS unidades, SUM(vi.subtotal) AS ingreso
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.id_venta
      WHERE ${whereSql}
      GROUP BY vi.id_producto, vi.nombre_snapshot
      ORDER BY ingreso DESC
    `, params),
    pool.query(`
      SELECT (v.fecha_hora AT TIME ZONE '${TZ}')::date AS fecha,
        COUNT(*)::int AS cantidad, SUM(v.total) AS total
      FROM ventas v
      WHERE ${whereSql}
      GROUP BY 1 ORDER BY 1
    `, params),
  ]);

  return {
    porProducto: porProducto.rows.map((r) => ({
      idProducto: r.id_producto, nombre: r.nombre_snapshot, unidades: r.unidades, ingreso: Number(r.ingreso),
    })),
    porDia: porDia.rows.map((r) => ({ fecha: r.fecha, cantidad: r.cantidad, total: Number(r.total) })),
  };
}

// Totales del día para el cierre de caja integrado: por método (vigentes) y anuladas aparte.
// `usuarioId` restringe a lo vendido por ese empleado (scoping lo decide el controller).
async function getTotalesDia({ fecha, usuarioId } = {}) {
  const params = [fecha];
  let filtroUsuario = '';
  if (usuarioId) { params.push(usuarioId); filtroUsuario = ' AND v.id_usuario = $2'; }

  const [{ rows: porMetodo }, { rows: anuladas }, { rows: porEmpleadoRows }] = await Promise.all([
    pool.query(`
      SELECT vp.metodo, COALESCE(SUM(vp.monto), 0) AS monto, COUNT(DISTINCT v.id)::int AS cantidad
      FROM ventas v
      JOIN venta_pagos vp ON vp.id_venta = v.id
      WHERE (v.fecha_hora AT TIME ZONE '${TZ}')::date = $1::date AND v.anulada = false${filtroUsuario}
      GROUP BY vp.metodo
    `, params),
    pool.query(`
      SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(v.total), 0) AS monto
      FROM ventas v
      WHERE (v.fecha_hora AT TIME ZONE '${TZ}')::date = $1::date AND v.anulada = true${filtroUsuario}
    `, params),
    pool.query(`
      SELECT v.id_usuario, u.nombre AS usuario_nombre, COUNT(*)::int AS cantidad, COALESCE(SUM(v.total), 0) AS monto
      FROM ventas v
      LEFT JOIN usuarios u ON u.id = v.id_usuario
      WHERE (v.fecha_hora AT TIME ZONE '${TZ}')::date = $1::date AND v.anulada = false${filtroUsuario}
      GROUP BY v.id_usuario, u.nombre
    `, params),
  ]);

  return {
    porMetodo: porMetodo.map((r) => ({ metodo: r.metodo, monto: Number(r.monto), cantidad: r.cantidad })),
    monto: porMetodo.reduce((acc, r) => acc + Number(r.monto), 0),
    cantidad: porMetodo.reduce((acc, r) => acc + r.cantidad, 0),
    porEmpleado: porEmpleadoRows.map((r) => ({
      usuarioId: r.id_usuario, usuarioNombre: r.usuario_nombre ?? 'Sin empleado asignado',
      monto: Number(r.monto), cantidad: r.cantidad,
    })),
    anulados: { cantidad: anuladas[0].cantidad, monto: Number(anuladas[0].monto) },
  };
}

// Total vendido hoy (no anulado), para el dashboard.
async function getTotalHoy() {
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(total), 0) AS total, COUNT(*)::int AS cantidad
    FROM ventas WHERE anulada = false AND (fecha_hora AT TIME ZONE '${TZ}')::date = ${HOY_SQL}
  `);
  return { total: Number(rows[0].total), cantidad: rows[0].cantidad };
}

module.exports = { findById, create, anular, findAll, getReportes, getTotalHoy, getTotalesDia };
