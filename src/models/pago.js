const { pool, withTransaction } = require('../config/db');
const { TZ, HOY_SQL, PERIODO_DIAS } = require('../config/fechas');
const { turnoSql } = require('../utils/turno');

// Resuelve el `metodo` resumen de pagos.metodo ('efectivo' | 'transferencia' | 'mixto') y las
// filas de pago_metodos a insertar, a partir de `metodo` legacy o de un desglose explícito.
// Siempre devuelve al menos una fila: toda cuota debe terminar con desglose en pago_metodos.
function resolverDesglose({ metodo, monto, desglose }) {
  if (!desglose) return { metodoResumen: metodo, filas: [{ metodo, monto }] };
  const metodosUsados = [...new Set(desglose.map((d) => d.metodo))];
  return {
    metodoResumen: metodosUsados.length > 1 ? 'mixto' : metodosUsados[0],
    filas: desglose,
  };
}

// Registra el pago y renueva la cuota del cliente de forma atómica.
// El período arranca en el vencimiento actual (si aún no venció) o en hoy, calculado en SQL
// para usar la fecha de la zona horaria del gimnasio y no la del proceso Node.
// `desglose` (opcional) es un array [{ metodo, monto }] cuya suma debe ser igual a `monto`;
// si no se manda, se usa el `metodo` único (comportamiento de siempre, compatible con el front viejo).
async function create({ cliente_id, usuario_id, monto, metodo, desglose }) {
  const { metodoResumen, filas } = resolverDesglose({ metodo, monto, desglose });

  const pagoId = await withTransaction(async (client) => {
    const { rows: clienteRows } = await client.query(
      `SELECT GREATEST(fecha_vencimiento, ${HOY_SQL}) AS desde FROM clientes WHERE id = $1 FOR UPDATE`,
      [cliente_id]
    );
    if (!clienteRows[0]) throw new Error('CLIENTE_NO_ENCONTRADO');
    const desde = clienteRows[0].desde;

    const { rows } = await client.query(
      `INSERT INTO pagos (cliente_id, usuario_id, monto, metodo, periodo_desde, periodo_hasta)
       VALUES ($1,$2,$3,$4,$5::date,$5::date + $6::int) RETURNING id, periodo_hasta`,
      [cliente_id, usuario_id, monto, metodoResumen, desde, PERIODO_DIAS]
    );
    const pagoId = rows[0].id;

    for (const f of filas) {
      await client.query(
        'INSERT INTO pago_metodos (id_pago, metodo, monto) VALUES ($1,$2,$3)',
        [pagoId, f.metodo, f.monto]
      );
    }

    await client.query(
      `UPDATE clientes SET fecha_vencimiento = $1, fecha_inicio_cuota = $2, estado = 'activo', updated_at = now()
       WHERE id = $3`,
      [rows[0].periodo_hasta, desde, cliente_id]
    );
    return pagoId;
  });
  return findById(pagoId);
}

// Anula el pago más reciente no anulado de un cliente y revierte la cuota al estado
// que tenía antes de ese cobro. Bloquea primero el cliente (mismo orden que `create`,
// para no deadlockear con un cobro concurrente) y luego el pago "más reciente" candidato,
// de forma que dos anulaciones concurrentes sobre el mismo cliente se serialicen.
async function anular({ id, usuario_id, motivo }) {
  return withTransaction(async (client) => {
    const { rows: pagoRows } = await client.query(
      'SELECT cliente_id, anulado FROM pagos WHERE id = $1',
      [id]
    );
    if (!pagoRows[0]) throw new Error('PAGO_NO_ENCONTRADO');
    if (pagoRows[0].anulado) throw new Error('PAGO_YA_ANULADO');
    const clienteId = pagoRows[0].cliente_id;

    const { rows: clienteRows } = await client.query(
      'SELECT id FROM clientes WHERE id = $1 FOR UPDATE',
      [clienteId]
    );
    if (!clienteRows[0]) throw new Error('CLIENTE_NO_ENCONTRADO');

    const { rows: ultimoRows } = await client.query(
      `SELECT id FROM pagos WHERE cliente_id = $1 AND anulado = false
       ORDER BY fecha_pago DESC LIMIT 1 FOR UPDATE`,
      [clienteId]
    );
    if (ultimoRows[0]?.id !== id) throw new Error('PAGO_NO_ES_ULTIMO');

    await client.query(
      `UPDATE pagos SET anulado = true, anulado_at = now(), anulado_por = $2, motivo_anulacion = $3
       WHERE id = $1`,
      [id, usuario_id, motivo]
    );

    const { rows: restantes } = await client.query(
      `SELECT periodo_desde, periodo_hasta FROM pagos
       WHERE cliente_id = $1 AND anulado = false
       ORDER BY fecha_pago DESC LIMIT 1`,
      [clienteId]
    );

    if (restantes[0]) {
      await client.query(
        `UPDATE clientes SET fecha_inicio_cuota = $1, fecha_vencimiento = $2, updated_at = now() WHERE id = $3`,
        [restantes[0].periodo_desde, restantes[0].periodo_hasta, clienteId]
      );
    } else {
      // Sin pagos vigentes: la cuota vuelve al estado que tiene un cliente recién creado, que
      // arranca en su fecha de alta (ver clienteController.create).
      await client.query(
        `UPDATE clientes SET fecha_inicio_cuota = fecha_alta, fecha_vencimiento = fecha_alta + $2::int, updated_at = now()
         WHERE id = $1`,
        [clienteId, PERIODO_DIAS]
      );
    }
    return findById(id);
  });
}

// Subconsulta reutilizada por findById/findAll/findByCliente: el desglose por método
// vive siempre en pago_metodos (incluso para pagos de un solo método, por el backfill),
// así que es la única fuente de verdad para quien necesite el detalle.
const METODOS_SQL = `COALESCE((
  SELECT json_agg(json_build_object('metodo', pm.metodo, 'monto', pm.monto) ORDER BY pm.id)
  FROM pago_metodos pm WHERE pm.id_pago = pagos.id
), '[]')`;

async function findById(id) {
  const { rows } = await pool.query(
    `SELECT pagos.*, ${METODOS_SQL} AS metodos FROM pagos WHERE id = $1`, [id]
  );
  return rows[0] ?? null;
}

async function findByCliente(cliente_id) {
  const { rows } = await pool.query(
    `SELECT pagos.*, ${METODOS_SQL} AS metodos FROM pagos WHERE cliente_id = $1 ORDER BY fecha_pago DESC`,
    [cliente_id]
  );
  return rows;
}

// Arma el WHERE compartido por `findAll` y `count` a partir de los mismos filtros,
// para que la paginación no pueda desincronizarse del listado.
function buildFiltros({ desde, hasta, metodo, turno, usuarioId, estado, clienteQuery } = {}) {
  const where = ['1=1'];
  const params = [];
  const p = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (desde) where.push(`(p.fecha_pago AT TIME ZONE '${TZ}')::date >= ${p(desde)}`);
  if (hasta) where.push(`(p.fecha_pago AT TIME ZONE '${TZ}')::date <= ${p(hasta)}`);
  // efectivo/transferencia incluyen también los cobros mixtos que tuvieron ese componente.
  // EXISTS (y no JOIN) para no duplicar el pago si tiene varios componentes del mismo método.
  // "mixto" filtra solo por el resumen pagos.metodo.
  if (metodo === 'efectivo' || metodo === 'transferencia') {
    const ref = p(metodo);
    where.push(`(p.metodo = ${ref} OR EXISTS (
      SELECT 1 FROM pago_metodos pm WHERE pm.id_pago = p.id AND pm.metodo = ${ref}
    ))`);
  } else if (metodo) {
    where.push(`p.metodo = ${p(metodo)}`);
  }
  if (turno) where.push(`${turnoSql('p.fecha_pago')} = ${p(turno)}`);
  if (usuarioId) where.push(`p.usuario_id = ${p(usuarioId)}`);
  if (estado === 'anulado') where.push('p.anulado = true');
  if (estado === 'vigente') where.push('p.anulado = false');
  if (clienteQuery) {
    where.push(`(c.nombre || ' ' || c.apellido || ' ' || c.dni) ILIKE ${p(`%${clienteQuery}%`)}`);
  }

  return { whereSql: where.join(' AND '), params, p };
}

async function findAll({ limit = 50, offset = 0, ...filtros } = {}) {
  const { whereSql, params, p } = buildFiltros(filtros);
  const { rows } = await pool.query(`
    SELECT p.*,
      c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.dni AS cliente_dni,
      u.nombre AS usuario_nombre, a.nombre AS anulado_por_nombre,
      COALESCE((
        SELECT json_agg(json_build_object('metodo', pm.metodo, 'monto', pm.monto) ORDER BY pm.id)
        FROM pago_metodos pm WHERE pm.id_pago = p.id
      ), '[]') AS metodos
    FROM pagos p
    JOIN clientes c ON c.id = p.cliente_id
    LEFT JOIN usuarios u ON u.id = p.usuario_id
    LEFT JOIN usuarios a ON a.id = p.anulado_por
    WHERE ${whereSql}
    ORDER BY p.fecha_pago DESC
    LIMIT ${p(limit)} OFFSET ${p(offset)}
  `, params);
  return rows;
}

async function count(filtros = {}) {
  const { whereSql, params } = buildFiltros(filtros);
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM pagos p
    JOIN clientes c ON c.id = p.cliente_id
    WHERE ${whereSql}
  `, params);
  return rows[0].total;
}

// hoy/semana/mes vigentes + su período anterior comparable, y cantidad/ticket promedio del mes.
// Excluye pagos anulados: es el único lugar donde "facturación" debe reflejar guita real cobrada.
async function getStatsFacturacion() {
  const { rows } = await pool.query(`
    WITH p AS (
      SELECT monto, (fecha_pago AT TIME ZONE '${TZ}') AS local
      FROM pagos WHERE anulado = false
    )
    SELECT
      COALESCE(SUM(monto) FILTER (WHERE local::date = ${HOY_SQL}), 0) AS hoy,
      COALESCE(SUM(monto) FILTER (WHERE local::date = ${HOY_SQL} - 1), 0) AS ayer,
      COALESCE(SUM(monto) FILTER (WHERE local >= date_trunc('week', ${HOY_SQL})), 0) AS semana,
      COALESCE(SUM(monto) FILTER (
        WHERE local >= date_trunc('week', ${HOY_SQL}) - interval '7 days'
          AND local < date_trunc('week', ${HOY_SQL})
      ), 0) AS semana_anterior,
      COALESCE(SUM(monto) FILTER (WHERE local >= date_trunc('month', ${HOY_SQL})), 0) AS mes,
      COALESCE(SUM(monto) FILTER (
        WHERE local >= date_trunc('month', ${HOY_SQL}) - interval '1 month'
          AND local < date_trunc('month', ${HOY_SQL})
      ), 0) AS mes_anterior,
      COUNT(*) FILTER (WHERE local >= date_trunc('month', ${HOY_SQL}))::int AS cantidad_pagos_mes
    FROM p
  `);
  const r = rows[0];
  const mes = Number(r.mes);
  const cantidadPagosMes = Number(r.cantidad_pagos_mes);
  return {
    hoy: Number(r.hoy),
    ayer: Number(r.ayer),
    semana: Number(r.semana),
    semanaAnterior: Number(r.semana_anterior),
    mes,
    mesAnterior: Number(r.mes_anterior),
    cantidadPagosMes,
    ticketPromedioMes: cantidadPagosMes > 0 ? mes / cantidadPagosMes : 0,
  };
}

// Cierre de caja de un día: totales generales, por método y por empleado (con su propio
// desglose por método), más las anulaciones del día aparte como dato informativo.
// `usuarioId` restringe todo al turno de ese empleado (lo decide el controller según permisos).
//
// El desglose por método SIEMPRE se lee de pago_metodos (no de pagos.metodo, que puede ser
// 'mixto'): así un cobro dividido entre efectivo y transferencia aporta a ambos buckets por
// el monto real de cada uno. Los totales generales/por-empleado, en cambio, se calculan sobre
// `pagos` directamente para no contar dos veces un mismo cobro dividido.
async function getCierreCaja({ fecha, usuarioId } = {}) {
  const params = [fecha];
  let filtroUsuario = '';
  if (usuarioId) {
    params.push(usuarioId);
    filtroUsuario = ` AND p.usuario_id = $2`;
  }

  const [{ rows: totales }, { rows: porMetodoRows }] = await Promise.all([
    pool.query(`
      SELECT p.usuario_id, u.nombre AS usuario_nombre, p.anulado,
        COUNT(*)::int AS cantidad, COALESCE(SUM(p.monto), 0) AS monto
      FROM pagos p
      LEFT JOIN usuarios u ON u.id = p.usuario_id
      WHERE (p.fecha_pago AT TIME ZONE '${TZ}')::date = $1::date${filtroUsuario}
      GROUP BY p.usuario_id, u.nombre, p.anulado
    `, params),
    pool.query(`
      SELECT p.usuario_id, pm.metodo, p.anulado,
        COUNT(DISTINCT p.id)::int AS cantidad, COALESCE(SUM(pm.monto), 0) AS monto
      FROM pagos p
      JOIN pago_metodos pm ON pm.id_pago = p.id
      WHERE (p.fecha_pago AT TIME ZONE '${TZ}')::date = $1::date${filtroUsuario}
      GROUP BY p.usuario_id, pm.metodo, p.anulado
    `, params),
  ]);

  const totalesVigentes = totales.filter((r) => !r.anulado);
  const totalesAnulados = totales.filter((r) => r.anulado);
  const porMetodoVigentes = porMetodoRows.filter((r) => !r.anulado);

  const porMetodoMap = new Map();
  for (const r of porMetodoVigentes) {
    const acc = porMetodoMap.get(r.metodo) ?? { metodo: r.metodo, monto: 0, cantidad: 0 };
    acc.monto += Number(r.monto);
    acc.cantidad += r.cantidad;
    porMetodoMap.set(r.metodo, acc);
  }

  const porEmpleadoMap = new Map();
  for (const r of totalesVigentes) {
    const empKey = r.usuario_id ?? 'sin-empleado';
    porEmpleadoMap.set(empKey, {
      usuarioId: r.usuario_id,
      usuarioNombre: r.usuario_nombre ?? 'Sin empleado asignado',
      monto: Number(r.monto),
      cantidad: r.cantidad,
      porMetodo: [],
    });
  }
  for (const r of porMetodoVigentes) {
    const empKey = r.usuario_id ?? 'sin-empleado';
    const emp = porEmpleadoMap.get(empKey);
    if (emp) emp.porMetodo.push({ metodo: r.metodo, monto: Number(r.monto), cantidad: r.cantidad });
  }

  return {
    fecha,
    general: {
      monto: totalesVigentes.reduce((acc, r) => acc + Number(r.monto), 0),
      cantidad: totalesVigentes.reduce((acc, r) => acc + r.cantidad, 0),
    },
    porMetodo: [...porMetodoMap.values()],
    porEmpleado: [...porEmpleadoMap.values()],
    anulados: {
      cantidad: totalesAnulados.reduce((acc, r) => acc + r.cantidad, 0),
      monto: totalesAnulados.reduce((acc, r) => acc + Number(r.monto), 0),
    },
  };
}

module.exports = {
  create, anular, findById, findByCliente, findAll, count, getStatsFacturacion, getCierreCaja,
};
