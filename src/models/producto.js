const { pool, withTransaction } = require('../config/db');

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function findByNombre(nombre) {
  const { rows } = await pool.query('SELECT * FROM productos WHERE lower(nombre) = lower($1)', [nombre]);
  return rows[0] ?? null;
}

async function create({ nombre, descripcion, categoria, precio, controla_stock, stock_actual, stock_minimo }) {
  const { rows } = await pool.query(
    `INSERT INTO productos (nombre, descripcion, categoria, precio, controla_stock, stock_actual, stock_minimo)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [nombre, descripcion ?? null, categoria ?? null, precio, controla_stock,
     controla_stock ? (stock_actual ?? 0) : null, controla_stock ? (stock_minimo ?? null) : null]
  );
  return findById(rows[0].id);
}

async function update(id, { nombre, descripcion, categoria, precio, controla_stock, stock_actual, stock_minimo }) {
  await pool.query(
    `UPDATE productos SET
       nombre=$1, descripcion=$2, categoria=$3, precio=$4, controla_stock=$5,
       stock_actual=$6, stock_minimo=$7, updated_at=now()
     WHERE id=$8`,
    [nombre, descripcion ?? null, categoria ?? null, precio, controla_stock,
     controla_stock ? stock_actual : null, controla_stock ? stock_minimo : null, id]
  );
  return findById(id);
}

async function toggleActivo(id, activo) {
  await pool.query('UPDATE productos SET activo = $1, updated_at = now() WHERE id = $2', [activo, id]);
  return findById(id);
}

function buildFiltros({ query, activo } = {}) {
  const where = ['1=1'];
  const params = [];
  const p = (value) => { params.push(value); return `$${params.length}`; };
  if (query) where.push(`nombre ILIKE ${p(`%${query}%`)}`);
  if (activo === true) where.push('activo = true');
  if (activo === false) where.push('activo = false');
  return { whereSql: where.join(' AND '), params, p };
}

async function findAll({ query, activo, limit = 20, offset = 0 } = {}) {
  const { whereSql, params, p } = buildFiltros({ query, activo });
  const { rows } = await pool.query(`
    SELECT *, COUNT(*) OVER()::int AS total_count
    FROM productos
    WHERE ${whereSql}
    ORDER BY nombre
    LIMIT ${p(limit)} OFFSET ${p(offset)}
  `, params);
  return {
    rows: rows.map(({ total_count, ...r }) => r),
    totalCount: rows[0]?.total_count ?? 0,
  };
}

// Ajuste manual de stock: delta puede ser positivo o negativo. 409 si el resultado queda negativo.
// Queda auditado en movimientos_stock con tipo 'ajuste'.
async function ajustarStock({ id, delta, usuario_id }) {
  // findById debe ejecutarse DESPUÉS de que la transacción haga COMMIT: usa `pool` (una conexión
  // distinta a la del cliente de la transacción), así que si se llamara adentro del callback
  // leería el valor previo al UPDATE (todavía no visible fuera de la transacción).
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM productos WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new Error('PRODUCTO_NO_ENCONTRADO');
    const producto = rows[0];
    if (!producto.controla_stock) throw new Error('PRODUCTO_NO_CONTROLA_STOCK');

    const nuevoStock = producto.stock_actual + delta;
    if (nuevoStock < 0) throw new Error('STOCK_INSUFICIENTE');

    await client.query('UPDATE productos SET stock_actual = $1, updated_at = now() WHERE id = $2', [nuevoStock, id]);
    await client.query(
      `INSERT INTO movimientos_stock (id_producto, tipo, cantidad, id_usuario) VALUES ($1,'ajuste',$2,$3)`,
      [id, delta, usuario_id]
    );
  });
  return findById(id);
}

module.exports = { findById, findByNombre, create, update, toggleActivo, findAll, ajustarStock };
