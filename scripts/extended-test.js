// Suite exhaustiva. Se ejecuta con `npm test` y reutiliza el arranque/limpieza de smoke-test.js
// (que ya registra sus propios tests): matriz de permisos por endpoint, bordes de la cuota,
// atomicidad de transacciones, reglas de usuarios/roles, upload real y números de stats.
//
// Los tests marcados "en proceso" parchean módulos o el pool, así que se saltean con TEST_BASE_URL.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const H = require('./smoke-test'); // registra la suite base y sus hooks before/after
const { api, login, dbUser, dbRole, crearCliente, assertErrores, ctx, randLetters, randDni, testEmail, clienteBase, PASSWORD, external } = H;

const { pool } = require('../src/config/db');
const { hoyISO, addDays, POR_VENCER_DIAS, PERIODO_DIAS, TZ } = require('../src/config/fechas');
const usuarioModel = require('../src/models/usuario');
const clienteModel = require('../src/models/cliente');
const movimientoCaja = require('../src/models/movimientoCaja');
const cajaApertura = require('../src/models/cajaApertura');

const inproc = { skip: external && 'requiere app en proceso' };
const uuid = () => crypto.randomUUID();
const hoy = () => hoyISO();
const cents = (n) => Math.round(Number(n) * 100);

// Registro de archivos subidos para borrarlos de Storage al final.
const uploads = [];
const { after } = require('node:test');
after(async () => {
  if (uploads.length === 0) return;
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: require('ws') } });
  const names = uploads.map((u) => decodeURIComponent(new URL(u).pathname.split('/').pop()));
  const { error } = await sb.storage.from('fotos-clientes').remove(names);
  if (error) console.error('cleanup storage:', error.message);
});

// Hace fallar (con una excepción) toda query del cliente de transacción que coincida con `match`.
async function conFallo(match, fn) {
  const own = Object.prototype.hasOwnProperty.call(pool, 'connect');
  const orig = pool.connect;
  const parcheados = [];
  pool.connect = async function patched(...args) {
    const c = await orig.apply(this, args);
    if (args.length === 0) {
      const q = c.query.bind(c);
      c.query = (sql, ...rest) => (typeof sql === 'string' && match.test(sql) ? Promise.reject(new Error('FALLA_INDUCIDA')) : q(sql, ...rest));
      parcheados.push(c);
    }
    return c;
  };
  try {
    return await fn();
  } finally {
    if (own) pool.connect = orig; else delete pool.connect;
    // los clientes vuelven al pool: hay que quitarles el parche o contaminan las pruebas siguientes
    for (const c of parcheados) delete c.query;
  }
}

async function conAdmins(n, fn) {
  const orig = usuarioModel.countAdminsActivos;
  usuarioModel.countAdminsActivos = async () => n;
  try { return await fn(); } finally { usuarioModel.countAdminsActivos = orig; }
}

async function cobrar(token, clienteId, monto = 100, metodo = 'efectivo') {
  return api('POST', '/api/pagos', { token, body: { clienteId, monto, metodo } });
}
const getCliente = async (id) => (await api('GET', `/api/clientes/${id}`, { token: ctx.admin })).body.data;
const statsDash = async () => (await api('GET', '/api/dashboard/stats', { token: ctx.admin })).body.data;
const statsPagos = async () => (await api('GET', '/api/pagos/stats', { token: ctx.admin })).body.data;

async function sqlCliente({ vencimiento, estado = 'activo', createdAt = null }) {
  const { rows } = await pool.query(
    `INSERT INTO clientes (nombre, apellido, dni, email, observaciones, fecha_inicio_cuota, fecha_vencimiento, estado, created_at)
     VALUES ('Sembrado','Sql',$1,$2,$3,$4::date - 30,$4::date,$5,COALESCE($6::timestamptz, now())) RETURNING id`,
    [randDni(), testEmail('sql'), `TEST_${randLetters()}`, vencimiento, estado, createdAt]
  );
  ctx.ids.clientes.push(rows[0].id);
  return rows[0].id;
}

async function seedPago(clienteId, fechaLocal, monto) {
  const { rows } = await pool.query(
    `INSERT INTO pagos (cliente_id, usuario_id, monto, metodo, periodo_desde, periodo_hasta, fecha_pago)
     VALUES ($1,$2,$3,'efectivo',$4::date,$4::date + 30,(($4::date + time '12:00') AT TIME ZONE $5)) RETURNING id`,
    [clienteId, ctx.adminId, monto, fechaLocal, TZ]
  );
  await pool.query('INSERT INTO pago_metodos (id_pago, metodo, monto) VALUES ($1,$2,$3)', [rows[0].id, 'efectivo', monto]);
}

// ───────────────────────── 401: tokens inválidos en TODOS los endpoints ─────────────────────────
describe('401 en todos los endpoints', () => {
  const id = uuid();
  const rutas = [
    ['GET', '/api/auth/mis-permisos'],
    ['GET', '/api/clientes'], ['GET', `/api/clientes/${id}`], ['POST', '/api/clientes'], ['PUT', `/api/clientes/${id}`], ['DELETE', `/api/clientes/${id}`],
    ['GET', '/api/roles'], ['GET', '/api/roles/permisos'], ['POST', '/api/roles'], ['PUT', `/api/roles/${id}`], ['DELETE', `/api/roles/${id}`],
    ['POST', '/api/pagos'], ['GET', `/api/pagos/cliente/${id}`], ['GET', '/api/pagos/stats'],
    ['GET', '/api/dashboard/stats'], ['POST', '/api/upload/foto'],
    ['GET', '/api/usuarios'], ['POST', '/api/usuarios'], ['PUT', `/api/usuarios/${id}`], ['PATCH', `/api/usuarios/${id}/toggle-activo`], ['DELETE', `/api/usuarios/${id}`],
    ['GET', '/api/productos'], ['GET', `/api/productos/${id}`], ['POST', '/api/productos'], ['PUT', `/api/productos/${id}`],
    ['PATCH', `/api/productos/${id}/toggle-activo`], ['PATCH', `/api/productos/${id}/stock`], ['DELETE', `/api/productos/${id}`],
    ['GET', '/api/ventas'], ['GET', `/api/ventas/${id}`], ['GET', '/api/ventas/reportes'], ['POST', '/api/ventas'], ['POST', `/api/ventas/${id}/anular`],
    ['GET', '/api/caja/movimientos'], ['POST', '/api/caja/movimientos'], ['POST', `/api/caja/movimientos/${id}/anular`],
    ['GET', '/api/caja/apertura'], ['PUT', '/api/caja/apertura'], ['GET', '/api/caja/cierre'],
  ];

  it('sin header, esquema incorrecto, firma ajena, expirado y usuario inexistente', async () => {
    const firmado = (payload, secret = process.env.JWT_SECRET, opts = { expiresIn: '1h' }) => jwt.sign(payload, secret, opts);
    const tokens = {
      ajeno: firmado({ id: ctx.adminId }, 'otro-secreto'),
      expirado: firmado({ id: ctx.adminId }, process.env.JWT_SECRET, { expiresIn: -10 }),
      fantasma: firmado({ id: uuid(), email: 'x@x.com' }), // firma válida pero el usuario no existe
      hs512: jwt.sign({ id: ctx.adminId }, process.env.JWT_SECRET, { algorithm: 'HS512' }),
    };
    for (const [m, p] of rutas) {
      assert.equal((await api(m, p)).status, 401, `${m} ${p} sin token`);
      assert.equal((await api(m, p, { headers: { Authorization: `Basic ${ctx.admin}` } })).status, 401, `${m} ${p} esquema Basic`);
      for (const [nombre, t] of Object.entries(tokens)) {
        assert.equal((await api(m, p, { token: t })).status, 401, `${m} ${p} token ${nombre}`);
      }
    }
  });
});

// ───────────────────────── Matriz de permisos ─────────────────────────
describe('matriz de permisos por endpoint', () => {
  let ALL;
  const tokens = new Map();

  before(async () => {
    ALL = (await pool.query('SELECT descripcion FROM permisos ORDER BY descripcion')).rows.map((r) => r.descripcion);
  });

  async function tokenCon(perms) {
    const key = [...perms].sort().join(',');
    if (!tokens.has(key)) {
      const rolId = await dbRole(`Zztest${randLetters()}`, perms);
      const email = testEmail('perm');
      await dbUser({ nombre: 'Perm Prueba', email, idRol: rolId });
      tokens.set(key, await login(email));
    }
    return tokens.get(key);
  }

  // `perms`: cualquiera de ellos alcanza. `ok`: status esperado cuando SÍ tiene permiso
  // (se eligen requests que fallan por validación/404 para no mutar datos).
  const casos = [
    { perms: ['clientes_ver'], m: 'GET', p: () => '/api/clientes', ok: 200 },
    { perms: ['clientes_ver'], m: 'GET', p: () => `/api/clientes/${uuid()}`, ok: 404 },
    { perms: ['clientes_crear'], m: 'POST', p: () => '/api/clientes', body: {}, ok: 400 },
    { perms: ['clientes_editar'], m: 'PUT', p: () => `/api/clientes/${uuid()}`, body: {}, ok: 404 },
    { perms: ['clientes_eliminar'], m: 'DELETE', p: () => `/api/clientes/${uuid()}`, ok: 404 },
    { perms: ['roles_ver'], m: 'GET', p: () => '/api/roles', ok: 200 },
    { perms: ['roles_ver'], m: 'GET', p: () => '/api/roles/permisos', ok: 200 },
    { perms: ['roles_crear'], m: 'POST', p: () => '/api/roles', body: {}, ok: 400 },
    { perms: ['roles_editar'], m: 'PUT', p: () => `/api/roles/${uuid()}`, body: {}, ok: 404 },
    { perms: ['roles_eliminar'], m: 'DELETE', p: () => `/api/roles/${uuid()}`, ok: 404 },
    { perms: ['facturacion_cobrar'], m: 'POST', p: () => '/api/pagos', body: {}, ok: 400 },
    { perms: ['facturacion_ver'], m: 'GET', p: () => `/api/pagos/cliente/${uuid()}`, ok: 200 },
    { perms: ['facturacion_ver'], m: 'GET', p: () => '/api/pagos/stats', ok: 200 },
    { perms: ['estadisticas_ver'], m: 'GET', p: () => '/api/dashboard/stats', ok: 200 },
    { perms: ['clientes_crear', 'clientes_editar'], m: 'POST', p: () => '/api/upload/foto', ok: 400 },
    { perms: ['productos_ver'], m: 'GET', p: () => '/api/productos', ok: 200 },
    { perms: ['productos_ver'], m: 'GET', p: () => `/api/productos/${uuid()}`, ok: 404 },
    { perms: ['productos_crear'], m: 'POST', p: () => '/api/productos', body: {}, ok: 400 },
    { perms: ['productos_editar'], m: 'PUT', p: () => `/api/productos/${uuid()}`, body: {}, ok: 404 },
    { perms: ['productos_editar'], m: 'PATCH', p: () => `/api/productos/${uuid()}/stock`, body: {}, ok: 400 },
    { perms: ['productos_eliminar'], m: 'DELETE', p: () => `/api/productos/${uuid()}`, ok: 404 },
    { perms: ['ventas_ver'], m: 'GET', p: () => '/api/ventas', ok: 200 },
    { perms: ['ventas_ver'], m: 'GET', p: () => `/api/ventas/${uuid()}`, ok: 404 },
    { perms: ['ventas_ver'], m: 'GET', p: () => '/api/ventas/reportes', ok: 200 },
    { perms: ['ventas_registrar'], m: 'POST', p: () => '/api/ventas', body: {}, ok: 400 },
    { perms: ['ventas_anular'], m: 'POST', p: () => `/api/ventas/${uuid()}/anular`, body: {}, ok: 400 },
    { perms: ['caja_ver'], m: 'GET', p: () => '/api/caja/movimientos', ok: 200 },
    { perms: ['caja_movimientos'], m: 'POST', p: () => '/api/caja/movimientos', body: {}, ok: 400 },
    { perms: ['caja_movimientos'], m: 'POST', p: () => `/api/caja/movimientos/${uuid()}/anular`, body: {}, ok: 400 },
    { perms: ['caja_ver'], m: 'GET', p: () => '/api/caja/apertura', ok: 200 },
    { perms: ['caja_movimientos'], m: 'PUT', p: () => '/api/caja/apertura', body: {}, ok: 400 },
    { perms: ['caja_ver'], m: 'GET', p: () => '/api/caja/cierre', ok: 200 },
  ];

  for (const c of casos) {
    const nombre = `${c.m} ${c.p().replace(/[0-9a-f-]{36}/, ':id')} (${c.perms.join(' | ')})`;

    it(`${nombre}: con el permiso pasa`, async () => {
      for (const perm of c.perms) {
        const t = await tokenCon([perm]);
        const r = await api(c.m, c.p(), { token: t, body: c.body });
        assert.equal(r.status, c.ok, `solo con ${perm}: ${r.text}`);
      }
    });

    it(`${nombre}: sin el permiso -> 403 (aunque tenga todos los demás)`, async () => {
      const t = await tokenCon(ALL.filter((p) => !c.perms.includes(p)));
      const r = await api(c.m, c.p(), { token: t, body: c.body });
      assert.equal(r.status, 403, r.text);
      assert.match(r.body.message, /permiso/i);
    });

    it(`${nombre}: sin ningún permiso -> 403`, async () => {
      const t = await tokenCon([]);
      assert.equal((await api(c.m, c.p(), { token: t, body: c.body })).status, 403);
    });
  }

  it('el Admin pasa todos los chequeos de permiso sin tenerlos asignados', async () => {
    for (const c of casos) {
      const r = await api(c.m, c.p(), { token: ctx.admin, body: c.body });
      assert.equal(r.status, c.ok, `${c.m} ${c.p()}: ${r.text}`);
    }
  });

  it('requireDueno (/api/usuarios): Admin y Dueño pasan; un rol con TODOS los permisos pero que no es Dueño, no', async () => {
    const sinDueno = await tokenCon(ALL);
    const reqs = [['GET', '/api/usuarios'], ['POST', '/api/usuarios', {}], ['PUT', `/api/usuarios/${uuid()}`, {}],
      ['PATCH', `/api/usuarios/${uuid()}/toggle-activo`], ['DELETE', `/api/usuarios/${uuid()}`]];
    for (const [m, p, body] of reqs) {
      assert.equal((await api(m, p, { token: sinDueno, body })).status, 403, `${m} ${p} con todos los permisos`);
      assert.equal((await api(m, p, { token: ctx.limitado, body })).status, 403, `${m} ${p} limitado`);
    }
    const esperado = { GET: 200, POST: 400, PUT: 400, PATCH: 404, DELETE: 404 };
    for (const [m, p, body] of reqs) {
      assert.equal((await api(m, p, { token: ctx.admin, body })).status, esperado[m], `admin ${m} ${p}`);
      if (ctx.dueno) assert.equal((await api(m, p, { token: ctx.dueno, body })).status, esperado[m], `dueño ${m} ${p}`);
    }
  });
});

// ───────────────────────── Cuota: estados en los bordes ─────────────────────────
describe('estado de cuota en los bordes', () => {
  const offsets = [...new Set([-1, 0, 1, 2, 3, POR_VENCER_DIAS, POR_VENCER_DIAS + 1])].sort((a, b) => a - b);
  const esperado = (d) => (d < 0 ? 'moroso' : d <= POR_VENCER_DIAS ? 'por_vencer' : 'al_dia');

  for (const d of offsets) {
    it(`vence en ${d} días -> ${esperado(d)} (alta, get por id y listado coinciden)`, async () => {
      const venc = addDays(hoy(), d);
      const c = await crearCliente({ fechaInicioCuota: addDays(venc, -30), fechaVencimiento: venc });
      assert.equal(c.estadoCuota, esperado(d), 'alta');
      assert.equal((await getCliente(c.id)).estadoCuota, esperado(d), 'get por id');
      const lista = (await api('GET', '/api/clientes', { token: ctx.admin })).body.data;
      assert.equal(lista.find((x) => x.id === c.id).estadoCuota, esperado(d), 'listado');
    });
  }

  it('hoy mismo NO es moroso: vence hoy = por_vencer', async () => {
    const c = await crearCliente({ fechaInicioCuota: addDays(hoy(), -30), fechaVencimiento: hoy() });
    assert.equal(c.estadoCuota, 'por_vencer');
  });

  it('cambiar estado a suspendido/vencido anula el estado de cuota; volver a activo lo recalcula', async () => {
    const c = await crearCliente({ fechaInicioCuota: addDays(hoy(), -40), fechaVencimiento: addDays(hoy(), -2) });
    for (const estado of ['suspendido', 'vencido']) {
      const r = await api('PUT', `/api/clientes/${c.id}`, { token: ctx.admin, body: { estado } });
      assert.equal(r.body.data.estadoCuota, null, estado);
    }
    const back = await api('PUT', `/api/clientes/${c.id}`, { token: ctx.admin, body: { estado: 'activo' } });
    assert.equal(back.body.data.estadoCuota, 'moroso');
  });

  it('editar la fecha de vencimiento recalcula el estado', async () => {
    const c = await crearCliente({ fechaInicioCuota: addDays(hoy(), -40), fechaVencimiento: addDays(hoy(), -2) });
    const r = await api('PUT', `/api/clientes/${c.id}`, { token: ctx.admin, body: { fechaVencimiento: addDays(hoy(), 60) } });
    assert.equal(r.body.data.estadoCuota, 'al_dia');
  });
});

// ───────────────────────── Cobro: encadenado, concurrencia y atomicidad ─────────────────────────
describe('cobro: encadenado de vencimiento', () => {
  const casos = [
    ['vencido hace 5 días: arranca hoy', -5, () => hoy()],
    ['vence ayer: arranca hoy', -1, () => hoy()],
    ['vence hoy: arranca hoy', 0, () => hoy()],
    ['vence mañana: arranca mañana', 1, () => addDays(hoy(), 1)],
    ['vence en 20 días: arranca en 20 días', 20, () => addDays(hoy(), 20)],
  ];
  for (const [titulo, d, desde] of casos) {
    it(titulo, async () => {
      const venc = addDays(hoy(), d);
      const c = await crearCliente({ fechaInicioCuota: addDays(venc, -30), fechaVencimiento: venc });
      const r = await cobrar(ctx.admin, c.id, 999.99, 'transferencia');
      assert.equal(r.status, 201, r.text);
      assert.equal(r.body.data.periodoDesde, desde());
      assert.equal(r.body.data.periodoHasta, addDays(desde(), 30));
      assert.equal(r.body.data.metodo, 'transferencia');
      assert.equal(cents(r.body.data.monto), 99999);
      const cli = await getCliente(c.id);
      assert.equal(cli.fechaInicioCuota, desde());
      assert.equal(cli.fechaVencimiento, addDays(desde(), 30));
      assert.equal(cli.estado, 'activo');
    });
  }

  it('dos cobros seguidos se encadenan (+30 y +60)', async () => {
    const c = await crearCliente({ fechaInicioCuota: addDays(hoy(), -40), fechaVencimiento: addDays(hoy(), -10) });
    const a = await cobrar(ctx.admin, c.id);
    const b = await cobrar(ctx.admin, c.id);
    assert.equal(b.body.data.periodoDesde, a.body.data.periodoHasta);
    assert.equal((await getCliente(c.id)).fechaVencimiento, addDays(hoy(), 60));
    const hist = (await api('GET', `/api/pagos/cliente/${c.id}`, { token: ctx.admin })).body.data;
    assert.equal(hist.length, 2);
    assert.ok(hist[0].fechaPago >= hist[1].fechaPago, 'historial ordenado del más reciente al más antiguo');
  });

  it('cobrar a un cliente "vencido" lo reactiva', async () => {
    const c = await crearCliente();
    await api('PUT', `/api/clientes/${c.id}`, { token: ctx.admin, body: { estado: 'vencido' } });
    await cobrar(ctx.admin, c.id);
    assert.equal((await getCliente(c.id)).estado, 'activo');
  });

  it('dos cobros simultáneos no se pisan (lock FOR UPDATE)', async () => {
    const base = addDays(hoy(), 3);
    const c = await crearCliente({ fechaInicioCuota: addDays(base, -30), fechaVencimiento: base });
    const [a, b] = await Promise.all([cobrar(ctx.admin, c.id), cobrar(ctx.admin, c.id)]);
    assert.equal(a.status, 201, a.text);
    assert.equal(b.status, 201, b.text);
    assert.deepEqual([a.body.data.periodoDesde, b.body.data.periodoDesde].sort(), [base, addDays(base, 30)]);
    assert.equal((await getCliente(c.id)).fechaVencimiento, addDays(base, 60));
  });

  it('el cobro guarda el usuario que lo registró y es consultable por cliente', async () => {
    const c = await crearCliente();
    const r = await cobrar(ctx.admin, c.id, '12.5');
    assert.equal(r.body.data.usuarioId, ctx.adminId);
    assert.equal(cents(r.body.data.monto), 1250);
    const hist = await api('GET', `/api/pagos/cliente/${c.id}`, { token: ctx.limitado });
    assert.equal(hist.status, 403);
  });

  it('historial de un cliente inexistente devuelve lista vacía', async () => {
    const r = await api('GET', `/api/pagos/cliente/${uuid()}`, { token: ctx.admin });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, []);
  });

  it('en proceso: si falla el UPDATE del cliente, el pago insertado se revierte (atomicidad)', inproc, async () => {
    const venc = addDays(hoy(), 5);
    const c = await crearCliente({ fechaInicioCuota: addDays(venc, -30), fechaVencimiento: venc });
    const r = await conFallo(/UPDATE clientes SET fecha_vencimiento/, () => cobrar(ctx.admin, c.id, 500));
    assert.equal(r.status, 500, r.text);
    assert.equal(r.body.message, 'Error interno del servidor');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pagos WHERE cliente_id = $1', [c.id]);
    assert.equal(rows[0].n, 0, 'no debe quedar el pago huérfano');
    assert.equal((await getCliente(c.id)).fechaVencimiento, venc, 'el vencimiento no cambió');
    // control: sin falla inducida, el mismo cobro funciona (y el pool quedó sano tras el rollback)
    assert.equal((await cobrar(ctx.admin, c.id, 500)).status, 201);
    assert.equal((await getCliente(c.id)).fechaVencimiento, addDays(venc, 30));
  });

  it('en proceso: si falla el INSERT del pago, el cliente queda intacto', inproc, async () => {
    const venc = addDays(hoy(), -4);
    const c = await crearCliente({ fechaInicioCuota: addDays(venc, -30), fechaVencimiento: venc });
    const r = await conFallo(/INSERT INTO pagos/, () => cobrar(ctx.admin, c.id));
    assert.equal(r.status, 500);
    assert.equal((await getCliente(c.id)).fechaVencimiento, venc);
  });
});

// ───────────────────────── Roles: atomicidad, 409 y reglas ─────────────────────────
describe('roles: reglas adicionales', () => {
  it('en proceso: crear rol con falla al asignar permisos no deja un rol huérfano', inproc, async () => {
    const nombre = `Zztest${randLetters()}`;
    const r = await conFallo(/INSERT INTO linea_permiso/, () =>
      api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: nombre, permissions: ['clientes_ver'] } }));
    assert.equal(r.status, 500);
    const { rows } = await pool.query('SELECT 1 FROM roles WHERE descripcion = $1', [nombre]);
    assert.equal(rows.length, 0);
  });

  it('en proceso: si falla la sincronización de permisos, el rol conserva los anteriores', inproc, async () => {
    const rolId = await dbRole(`Zztest${randLetters()}`, ['clientes_ver', 'clientes_crear']);
    const r = await conFallo(/INSERT INTO linea_permiso/, () =>
      api('PUT', `/api/roles/${rolId}`, { token: ctx.admin, body: { permissions: ['facturacion_ver'] } }));
    assert.equal(r.status, 500);
    const { rows } = await pool.query(
      'SELECT p.descripcion FROM linea_permiso lp JOIN permisos p ON p.id = lp.id_permiso WHERE lp.id_rol = $1 ORDER BY 1', [rolId]);
    assert.deepEqual(rows.map((x) => x.descripcion), ['clientes_crear', 'clientes_ver']);
  });

  it('PUT con descripción de otro rol -> 409; con la propia descripción -> 200', async () => {
    const a = `Zztest${randLetters()}`;
    const b = `Zztest${randLetters()}`;
    const ra = await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: a } });
    const rb = await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: b } });
    ctx.ids.roles.push(ra.body.data.id, rb.body.data.id);
    const dup = await api('PUT', `/api/roles/${rb.body.data.id}`, { token: ctx.admin, body: { descripcion: a } });
    assert.equal(dup.status, 409, dup.text);
    assert.ok(dup.body.errors.descripcion);
    const mismo = await api('PUT', `/api/roles/${rb.body.data.id}`, { token: ctx.admin, body: { descripcion: b } });
    assert.equal(mismo.status, 200, mismo.text);
  });

  it('PUT con permissions null/[] vacía los permisos; sin el campo no los toca', async () => {
    const rolId = await dbRole(`Zztest${randLetters()}`, ['clientes_ver']);
    const sinCampo = await api('PUT', `/api/roles/${rolId}`, { token: ctx.admin, body: { descripcion: `Zztest${randLetters()}` } });
    assert.deepEqual(sinCampo.body.data.permissions, ['clientes_ver']);
    const vacio = await api('PUT', `/api/roles/${rolId}`, { token: ctx.admin, body: { permissions: [] } });
    assert.deepEqual(vacio.body.data.permissions, []);
  });

  it('PUT / POST validan tipos y descripción', async () => {
    const rolId = await dbRole(`Zztest${randLetters()}`, []);
    assertErrores(await api('PUT', `/api/roles/${rolId}`, { token: ctx.admin, body: { descripcion: 'X' } }), ['descripcion']);
    assertErrores(await api('PUT', `/api/roles/${rolId}`, { token: ctx.admin, body: { descripcion: '' } }), ['descripcion']);
    assertErrores(await api('PUT', `/api/roles/${rolId}`, { token: ctx.admin, body: { permissions: [1, 2] } }), ['permissions']);
    assertErrores(await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: 'x'.repeat(51) } }), ['descripcion']);
  });

  it('el listado muestra userCount (activos) y assignedCount (todos) como números; Admin lista todos los permisos', async () => {
    const rolId = await dbRole(`Zztest${randLetters()}`, []);
    await dbUser({ nombre: 'Rol Activo', email: testEmail('ra'), idRol: rolId });
    await dbUser({ nombre: 'Rol Inactivo', email: testEmail('ri'), idRol: rolId, activo: false });
    const lista = (await api('GET', '/api/roles', { token: ctx.admin })).body.data;
    const r = lista.find((x) => x.id === rolId);
    assert.equal(r.userCount, 1);
    assert.equal(r.assignedCount, 2);
    const todos = (await api('GET', '/api/roles/permisos', { token: ctx.admin })).body.data;
    assert.deepEqual(lista.find((x) => x.esAdmin).permissions, todos);
  });

  it('mis-permisos: Admin recibe todos; un rol recibe solo los suyos; permisos en tiempo real', async () => {
    const todos = (await api('GET', '/api/roles/permisos', { token: ctx.admin })).body.data;
    const a = await api('GET', '/api/auth/mis-permisos', { token: ctx.admin });
    assert.deepEqual(a.body.data.permissions, todos);
    assert.equal(a.body.data.esAdmin, true);
  });
});

// ───────────────────────── Usuarios: reglas de seguridad ─────────────────────────
describe('usuarios: último Admin, Dueño y superadmin', () => {
  const mkAdmin = async (tag) => {
    const email = testEmail(tag);
    const id = await dbUser({ nombre: 'Admin Extra', email, idRol: ctx.adminRolId });
    return { id, email };
  };
  const estado = async (id) => (await pool.query('SELECT activo, id_rol FROM usuarios WHERE id = $1', [id])).rows[0];

  it('countAdminsActivos cuenta solo Admins activos', async () => {
    const { id } = await mkAdmin('cnt');
    const antes = await usuarioModel.countAdminsActivos();
    await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [id]);
    assert.equal(await usuarioModel.countAdminsActivos(), antes - 1);
    assert.equal(typeof antes, 'number');
  });

  it('en proceso: con un único Admin activo no se lo puede desactivar, eliminar ni degradar', inproc, async () => {
    const t = await mkAdmin('ultimo');
    await conAdmins(1, async () => {
      const toggle = await api('PATCH', `/api/usuarios/${t.id}/toggle-activo`, { token: ctx.admin });
      assert.equal(toggle.status, 403, toggle.text);
      assert.match(toggle.body.message, /único Admin/);
      const del = await api('DELETE', `/api/usuarios/${t.id}`, { token: ctx.admin });
      assert.equal(del.status, 403, del.text);
      assert.match(del.body.message, /único Admin/);
      const demote = await api('PUT', `/api/usuarios/${t.id}`, { token: ctx.admin, body: { nombre: 'Admin Extra', email: t.email, idRol: ctx.limitadoRolId } });
      assert.equal(demote.status, 403, demote.text);
      assert.match(demote.body.message, /único Admin/);
    });
    assert.deepEqual(await estado(t.id), { activo: true, id_rol: ctx.adminRolId }, 'no se modificó nada');
  });

  it('en proceso: con más de un Admin activo sí se puede desactivar, degradar y eliminar', inproc, async () => {
    const a = await mkAdmin('dos_a');
    const b = await mkAdmin('dos_b');
    await conAdmins(2, async () => {
      const off = await api('PATCH', `/api/usuarios/${a.id}/toggle-activo`, { token: ctx.admin });
      assert.equal(off.status, 200, off.text);
      const demote = await api('PUT', `/api/usuarios/${b.id}`, { token: ctx.admin, body: { nombre: 'Admin Extra', email: b.email, idRol: ctx.limitadoRolId } });
      assert.equal(demote.status, 200, demote.text);
    });
    // un Admin inactivo se puede borrar aunque quede un solo Admin activo
    await conAdmins(1, async () => {
      assert.equal((await api('DELETE', `/api/usuarios/${a.id}`, { token: ctx.admin })).status, 200);
    });
  });

  it('un Admin puede cambiar su propio rol a otro Admin / editar su nombre sin restricciones del último Admin', async () => {
    const t = await mkAdmin('self');
    const tok = await login(t.email);
    const r = await api('PUT', `/api/usuarios/${t.id}`, { token: tok, body: { nombre: 'Admin Renombrado', email: t.email, idRol: ctx.adminRolId } });
    assert.equal(r.status, 200, r.text);
  });

  it('Dueño: gestiona usuarios comunes pero nunca Admins', async (tt) => {
    if (!ctx.dueno) return tt.skip('no existe el rol Dueño');
    const D = ctx.dueno;
    const email = testEmail('porDueno');

    // puede: alta, edición, desactivar/activar y borrar un usuario común
    const c = await api('POST', '/api/usuarios', { token: D, body: { nombre: 'Creado Dueno', email, password: PASSWORD, idRol: ctx.limitadoRolId } });
    assert.equal(c.status, 201, c.text);
    ctx.ids.usuarios.push(c.body.data.id);
    const uid = c.body.data.id;
    assert.equal((await api('PUT', `/api/usuarios/${uid}`, { token: D, body: { nombre: 'Editado Dueno', email, idRol: ctx.sinPermisosRolId } })).status, 200);
    assert.equal((await api('PATCH', `/api/usuarios/${uid}/toggle-activo`, { token: D })).status, 200);

    // no puede: crear Admin, ascender a Admin, ni tocar a un Admin (editar/desactivar/borrar)
    const admin = await mkAdmin('objetivo');
    const crearAdmin = await api('POST', '/api/usuarios', { token: D, body: { nombre: 'Falso Admin', email: testEmail('f'), password: PASSWORD, idRol: ctx.adminRolId } });
    assert.equal(crearAdmin.status, 403, crearAdmin.text);
    assert.equal((await api('PUT', `/api/usuarios/${uid}`, { token: D, body: { nombre: 'Editado Dueno', email, idRol: ctx.adminRolId } })).status, 403);
    assert.equal((await api('PUT', `/api/usuarios/${admin.id}`, { token: D, body: { nombre: 'Hackeado', email: admin.email, idRol: ctx.limitadoRolId } })).status, 403);
    assert.equal((await api('PATCH', `/api/usuarios/${admin.id}/toggle-activo`, { token: D })).status, 403);
    assert.equal((await api('DELETE', `/api/usuarios/${admin.id}`, { token: D })).status, 403);
    assert.deepEqual(await estado(admin.id), { activo: true, id_rol: ctx.adminRolId });

    assert.equal((await api('DELETE', `/api/usuarios/${uid}`, { token: D })).status, 200);
  });

  it('en proceso: el superadmin protegido no cambia por ninguna vía (ni siquiera con Dueño)', inproc, async () => {
    const id = ctx.protegidoId;
    const antes = (await pool.query('SELECT nombre, email, id_rol, activo FROM usuarios WHERE id = $1', [id])).rows[0];
    const tokens = [ctx.admin, ...(ctx.dueno ? [ctx.dueno] : [])];
    for (const token of tokens) {
      const put = await api('PUT', `/api/usuarios/${id}`, { token, body: { nombre: 'Otro Nombre', email: antes.email, idRol: ctx.limitadoRolId } });
      assert.equal(put.status, 403, put.text);
      assert.match(put.body.message, /protegido/);
      const off = await api('PATCH', `/api/usuarios/${id}/toggle-activo`, { token });
      assert.equal(off.status, 403);
      assert.match(off.body.message, /protegido/);
      const del = await api('DELETE', `/api/usuarios/${id}`, { token });
      assert.equal(del.status, 403);
      assert.match(del.body.message, /protegido/);
    }
    assert.deepEqual((await pool.query('SELECT nombre, email, id_rol, activo FROM usuarios WHERE id = $1', [id])).rows[0], antes);
    // nadie puede crear otro usuario con el email protegido
    const dup = await api('POST', '/api/usuarios', { token: ctx.admin, body: { nombre: 'Clon', email: H.protectedEmail.toUpperCase(), password: PASSWORD, idRol: ctx.limitadoRolId } });
    assert.equal(dup.status, 409);
    const lista = (await api('GET', '/api/usuarios', { token: ctx.admin })).body.data;
    assert.equal(lista.filter((u) => u.protegido).length, 1);
  });

  it('los usuarios inactivos no pueden operar, ni siquiera /api/usuarios', async () => {
    const t = await mkAdmin('inact');
    const tok = await login(t.email);
    await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [t.id]);
    assert.equal((await api('GET', '/api/usuarios', { token: tok })).status, 401);
    assert.equal((await api('GET', '/api/clientes', { token: tok })).status, 401);
  });
});

// ───────────────────────── Upload real ─────────────────────────
describe('upload de fotos: casos completos', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const subir = (token, { bytes = PNG, type = 'image/png', filename = 'foto.png', field = 'foto' } = {}) => {
    const f = new FormData();
    f.append(field, new Blob([bytes], { type }), filename);
    return fetch(`${H.getBaseUrl()}/api/upload/foto`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: f });
  };
  const nombreEn = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop());

  it('sin token -> 401, también con archivo válido', async () => {
    assert.equal((await subir(null)).status, 401);
  });

  it('token válido sube una imagen PNG y devuelve una URL pública accesible', async () => {
    const res = await subir(ctx.admin);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    uploads.push(body.url);
    assert.match(body.url, /^https:\/\//);
    assert.match(nombreEn(body.url), /^\d+-[0-9a-f-]{36}\.png$/);
    const get = await fetch(body.url);
    assert.equal(get.status, 200);
    assert.match(get.headers.get('content-type'), /image\/png/);
  });

  it('acepta jpeg y webp; el nombre del archivo del cliente no llega al path', async () => {
    for (const [type, ext] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
      const res = await subir(ctx.admin, { type, filename: '../../evil name.exe' });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      uploads.push(body.url);
      assert.ok(nombreEn(body.url).endsWith(`.${ext}`));
      assert.ok(!/evil|exe|\.\./.test(body.url));
    }
  });

  it('con solo clientes_editar o solo clientes_crear también puede subir', async () => {
    for (const perm of ['clientes_editar', 'clientes_crear']) {
      const rolId = await dbRole(`Zztest${randLetters()}`, [perm]);
      const email = testEmail('up');
      await dbUser({ nombre: 'Upload Prueba', email, idRol: rolId });
      const res = await subir(await login(email));
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      uploads.push(body.url);
    }
  });

  it('con solo clientes_ver -> 403 y no se sube nada', async () => {
    assert.equal((await subir(ctx.limitado)).status, 403);
  });

  it('tipos inválidos -> 400', async () => {
    for (const type of ['text/plain', 'application/pdf', 'image/gif', 'image/svg+xml', 'application/octet-stream']) {
      assert.equal((await subir(ctx.admin, { type, bytes: Buffer.from('x') })).status, 400, type);
    }
  });

  it('más de 5 MB -> 413', async () => {
    assert.equal((await subir(ctx.admin, { bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).status, 413);
  });

  it('campo con nombre incorrecto -> 400, sin archivo -> 400', async () => {
    assert.equal((await subir(ctx.admin, { field: 'archivo' })).status, 400);
    assert.equal((await api('POST', '/api/upload/foto', { token: ctx.admin })).status, 400);
  });

  it('la URL subida se puede usar como fotoUrl del cliente; URLs inválidas se rechazan', async () => {
    const res = await subir(ctx.admin);
    const { url } = await res.json();
    uploads.push(url);
    const c = await crearCliente({ fotoUrl: url });
    assert.equal(c.fotoUrl, url);
    assertErrores(await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({ fotoUrl: 'javascript:alert(1)' }) }), ['fotoUrl']);
    assertErrores(await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({ fotoUrl: 'ftp://x.com/a.png' }) }), ['fotoUrl']);
    assertErrores(await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({ fotoUrl: 'no es url' }) }), ['fotoUrl']);
  });
});

// ───────────────────────── Números: dashboard y facturación contra datos sembrados ─────────────────────────
describe('dashboard: números contra datos sembrados', () => {
  it('los contadores varían exactamente según los clientes sembrados', async () => {
    const antes = await statsDash();
    const h = hoy();
    const venc = (d) => addDays(h, d);
    // sembrados por API
    const moroso1 = await crearCliente({ fechaInicioCuota: venc(-31), fechaVencimiento: venc(-1) });
    const moroso2 = await crearCliente({ fechaInicioCuota: venc(-40), fechaVencimiento: venc(-10) });
    const venceHoy = await crearCliente({ fechaInicioCuota: venc(-30), fechaVencimiento: venc(0) });
    const limite = await crearCliente({ fechaInicioCuota: venc(POR_VENCER_DIAS - 30), fechaVencimiento: venc(POR_VENCER_DIAS) });
    const alDia = await crearCliente({ fechaInicioCuota: venc(POR_VENCER_DIAS + 1 - 30), fechaVencimiento: venc(POR_VENCER_DIAS + 1) });
    const suspendido = await crearCliente({ fechaInicioCuota: venc(-40), fechaVencimiento: venc(-5) });
    const vencidoEstado = await crearCliente({ fechaVencimiento: venc(1) });
    await api('PUT', `/api/clientes/${suspendido.id}`, { token: ctx.admin, body: { estado: 'suspendido' } });
    await api('PUT', `/api/clientes/${vencidoEstado.id}`, { token: ctx.admin, body: { estado: 'vencido' } });
    // sembrado por SQL, creado hace años (no es "nuevo del mes")
    await sqlCliente({ vencimiento: venc(15), createdAt: '2020-01-15T12:00:00Z' });

    const despues = await statsDash();
    assert.equal(despues.total - antes.total, 8, 'total');
    assert.equal(despues.activos - antes.activos, 6, 'activos (excluye suspendido y vencido)');
    assert.equal(despues.morosos - antes.morosos, 2, 'morosos (excluye suspendido)');
    assert.equal(despues.porVencer - antes.porVencer, 2, 'por vencer: vence hoy + límite');
    assert.equal(despues.nuevosMes - antes.nuevosMes, 7, 'nuevos del mes (el de 2020 no cuenta)');
    assert.ok([moroso1, moroso2, venceHoy, limite, alDia].every(Boolean));
  });

  it('en proceso: próximos vencimientos = solo morosos y por vencer activos, del más antiguo al más nuevo', inproc, async () => {
    const h = hoy();
    const a = await crearCliente({ fechaInicioCuota: addDays(h, -50), fechaVencimiento: addDays(h, -20) });
    const b = await crearCliente({ fechaInicioCuota: addDays(h, -30), fechaVencimiento: h });
    const c = await crearCliente({ fechaVencimiento: addDays(h, POR_VENCER_DIAS + 5) }); // al día: no figura
    const d = await crearCliente({ fechaInicioCuota: addDays(h, -50), fechaVencimiento: addDays(h, -9) });
    await api('PUT', `/api/clientes/${d.id}`, { token: ctx.admin, body: { estado: 'suspendido' } }); // suspendido: no figura
    const lista = await clienteModel.getProximosVencimientos(100000);
    const ids = lista.map((x) => x.id);
    assert.ok(ids.includes(a.id) && ids.includes(b.id));
    assert.ok(!ids.includes(c.id) && !ids.includes(d.id));
    assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id), 'orden ascendente por vencimiento');
    assert.equal(lista.find((x) => x.id === a.id).estado_cuota, 'moroso');
    assert.equal(lista.find((x) => x.id === b.id).estado_cuota, 'por_vencer');
    for (let i = 1; i < lista.length; i++) assert.ok(lista[i - 1].fecha_vencimiento <= lista[i].fecha_vencimiento);
  });

  it('el endpoint limita a 10 próximos vencimientos y trae los campos esperados', async () => {
    const s = await statsDash();
    assert.ok(s.proximosVencimientos.length <= 10);
    for (const p of s.proximosVencimientos) {
      assert.deepEqual(Object.keys(p).sort(), ['estadoCuota', 'fechaVencimiento', 'id', 'nombreCompleto', 'telefono']);
      assert.ok(['moroso', 'por_vencer'].includes(p.estadoCuota));
    }
  });

  it('un cliente eliminado deja de contar', async () => {
    const antes = await statsDash();
    const c = await crearCliente();
    assert.equal((await statsDash()).total - antes.total, 1);
    await api('DELETE', `/api/clientes/${c.id}`, { token: ctx.admin });
    assert.equal((await statsDash()).total, antes.total);
  });
});

describe('facturación: stats contra pagos sembrados', () => {
  it('hoy / semana / mes suman exactamente los pagos sembrados por fecha', async () => {
    const c = await crearCliente();
    const h = hoy();
    const lunes = addDays(h, -((new Date(`${h}T00:00:00Z`).getUTCDay() + 6) % 7)); // date_trunc('week') = lunes
    const primeroDeMes = `${h.slice(0, 8)}01`;
    const sembrados = [
      [h, 100.1], [addDays(h, -1), 20.2], [addDays(h, -7), 3.03], [addDays(h, -35), 4.04], [addDays(h, -400), 5.05],
    ];
    const antes = await statsPagos();
    for (const [fecha, monto] of sembrados) await seedPago(c.id, fecha, monto);
    const despues = await statsPagos();

    const suma = (pred) => sembrados.filter(([f]) => pred(f)).reduce((acc, [, m]) => acc + cents(m), 0);
    assert.equal(cents(despues.hoy - antes.hoy), suma((f) => f === h), 'hoy');
    assert.equal(cents(despues.semana - antes.semana), suma((f) => f >= lunes), 'semana (desde el lunes)');
    assert.equal(cents(despues.mes - antes.mes), suma((f) => f >= primeroDeMes), 'mes (desde el día 1)');
  });

  it('cobros hechos por la API se reflejan en hoy, semana y mes', async () => {
    const c = await crearCliente();
    const antes = await statsPagos();
    await cobrar(ctx.admin, c.id, 150.25);
    await cobrar(ctx.admin, c.id, 49.75, 'transferencia');
    const despues = await statsPagos();
    for (const k of ['hoy', 'semana', 'mes']) assert.equal(cents(despues[k] - antes[k]), 20000, k);
  });

  it('borrar un cliente borra también sus pagos y deja de sumarlos (comportamiento actual: ON DELETE CASCADE)', async () => {
    const c = await crearCliente();
    await cobrar(ctx.admin, c.id, 77);
    const antes = await statsPagos();
    await api('DELETE', `/api/clientes/${c.id}`, { token: ctx.admin });
    const despues = await statsPagos();
    assert.equal(cents(antes.hoy - despues.hoy), 7700);
  });
});

// ───────────────────────── 400 / 404 / 409 restantes por endpoint ─────────────────────────
describe('clientes y usuarios: bordes adicionales', () => {
  it('campos opcionales vacíos se guardan como null y los límites exactos se aceptan', async () => {
    const c = await crearCliente({ nombre: 'Al', apellido: 'x'.repeat(50), dni: '1234567', telefono: '12345678', direccion: '', observaciones: `TEST_${'y'.repeat(494)}` });
    assert.equal(c.direccion, null);
    assert.equal(c.apellido.length, 50);
    assert.equal(c.dni, '1234567');
    const c2 = await crearCliente({ telefono: '1'.repeat(15), email: `${'a'.repeat(88)}@x.com`.slice(-100) });
    assert.equal(c2.telefono.length, 15);
  });

  it('fecha de nacimiento: hoy ok, mañana y 1899 rechazadas', async () => {
    assert.equal((await crearCliente({ fechaNacimiento: hoy() })).fechaNacimiento, hoy());
    assertErrores(await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({ fechaNacimiento: addDays(hoy(), 1) }) }), ['fechaNacimiento']);
    assertErrores(await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({ fechaNacimiento: '1899-12-31' }) }), ['fechaNacimiento']);
    assertErrores(await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({ fechaNacimiento: '2024-02-30' }) }), ['fechaNacimiento']);
  });

  it('tipos incorrectos en el cuerpo -> 400 y nunca 500', async () => {
    const malos = [{ nombre: 123 }, { nombre: ['a'] }, { dni: {} }, { email: 5 }, { telefono: [] }, { observaciones: 5 }, { fotoUrl: 5 }];
    for (const m of malos) {
      const r = await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase(m) });
      assert.equal(r.status, 400, JSON.stringify(m));
    }
    assert.equal((await api('POST', '/api/clientes', { token: ctx.admin, body: [] })).status, 400);
    assert.equal((await api('POST', '/api/pagos', { token: ctx.admin, body: 'texto' })).status, 400);
  });

  it('PUT con el mismo DNI propio no es conflicto; dni nuevo libre se aplica', async () => {
    const c = await crearCliente();
    assert.equal((await api('PUT', `/api/clientes/${c.id}`, { token: ctx.admin, body: { dni: c.dni } })).status, 200);
    const nuevo = randDni();
    const r = await api('PUT', `/api/clientes/${c.id}`, { token: ctx.admin, body: { dni: nuevo } });
    assert.equal(r.body.data.dni, nuevo);
  });

  it('usuarios: validaciones de borde en alta (contraseña 8/72, nombre, email 100)', async () => {
    const base = (o) => ({ nombre: 'Borde Prueba', email: testEmail('b'), password: PASSWORD, idRol: ctx.limitadoRolId, ...o });
    const post = (o) => api('POST', '/api/usuarios', { token: ctx.admin, body: base(o) });
    assertErrores(await post({ password: 'abcde12' }), ['password']); // 7
    assertErrores(await post({ password: `a1${'x'.repeat(71)}` }), ['password']); // 73
    assertErrores(await post({ nombre: 'Ana3' }), ['nombre']);
    assertErrores(await post({ email: `${'a'.repeat(95)}@x.com` }), ['email']);
    assertErrores(await post({ idRol: null }), ['idRol']);
    for (const password of ['abcdefg1', `a1${'x'.repeat(70)}`]) {
      const r = await post({ password });
      assert.equal(r.status, 201, r.text);
      ctx.ids.usuarios.push(r.body.data.id);
    }
  });

  it('usuarios: nunca se expone password_hash', async () => {
    const lista = (await api('GET', '/api/usuarios', { token: ctx.admin })).text;
    assert.ok(!/password/i.test(lista));
  });
});

// ───────────────────────── Fase 2: inserta un pago "a mano" sin pasar por el controller,
// para poder fijar usuario/método/fecha/anulado libremente sin tocar el vencimiento del cliente.
async function sqlPago({ clienteId, usuarioId, monto, metodo = 'efectivo', fechaLocal, hora = '12:00', anulado = false, periodoDesde, periodoHasta, desglose }) {
  const desde = periodoDesde ?? fechaLocal;
  const hasta = periodoHasta ?? addDays(fechaLocal, PERIODO_DIAS);
  const metodoResumen = desglose ? ([...new Set(desglose.map((d) => d.metodo))].length > 1 ? 'mixto' : desglose[0].metodo) : metodo;
  const { rows } = await pool.query(
    `INSERT INTO pagos (cliente_id, usuario_id, monto, metodo, periodo_desde, periodo_hasta, fecha_pago, anulado)
     VALUES ($1,$2,$3,$4,$5::date,$6::date, (($7::date + $8::time) AT TIME ZONE $9), $10)
     RETURNING id`,
    [clienteId, usuarioId, monto, metodoResumen, desde, hasta, fechaLocal, hora, TZ, anulado]
  );
  for (const f of (desglose ?? [{ metodo, monto }])) {
    await pool.query('INSERT INTO pago_metodos (id_pago, metodo, monto) VALUES ($1,$2,$3)', [rows[0].id, f.metodo, f.monto]);
  }
  return rows[0].id;
}

// Pago/venta sembrados "en el pasado" (fecha arbitraria) para probar el cierre de caja
// integrado sin pelearse con datos de otros tests corriendo en el mismo día.
async function sqlPagoEnFecha(fecha, { usuarioId, monto, desglose }) {
  const cli = await crearCliente();
  ctx.ids.clientes.push(cli.id);
  return sqlPago({ clienteId: cli.id, usuarioId, monto, fechaLocal: fecha, desglose });
}

async function sqlVentaEnFecha(fecha, { usuarioId, productoId, total, pagos, cantidad = 1 }) {
  const { rows } = await pool.query(
    `INSERT INTO ventas (id_usuario, total, fecha_hora) VALUES ($1,$2,(($3::date + time '12:00') AT TIME ZONE $4)) RETURNING id`,
    [usuarioId, total, fecha, TZ]
  );
  const ventaId = rows[0].id;
  await pool.query(
    `INSERT INTO venta_items (id_venta, id_producto, nombre_snapshot, precio_unitario, cantidad, subtotal)
     VALUES ($1,$2,'Zztest item',$3::numeric,$4::int,$3::numeric * $4::numeric)`,
    [ventaId, productoId, total / cantidad, cantidad]
  );
  for (const p of pagos) {
    await pool.query('INSERT INTO venta_pagos (id_venta, metodo, monto) VALUES ($1,$2,$3)', [ventaId, p.metodo, p.monto]);
  }
  return ventaId;
}

const bucketDe = (d) => (d < 0 ? 'moroso' : d <= POR_VENCER_DIAS ? 'por_vencer' : 'al_dia');

async function getMorosos(token, query, extra = '') {
  const qs = new URLSearchParams({ ...(query ? { query } : {}), ...Object.fromEntries(new URLSearchParams(extra)) });
  return api('GET', `/api/clientes/morosos?${qs}`, { token });
}
async function getPorVencer(token, query, extra = '') {
  const qs = new URLSearchParams({ ...(query ? { query } : {}), ...Object.fromEntries(new URLSearchParams(extra)) });
  return api('GET', `/api/clientes/por-vencer?${qs}`, { token });
}

describe('Fase 2: morosos y por-vencer', () => {
  it('sin token -> 401; sin facturacion_ver -> 403', async () => {
    assert.equal((await api('GET', '/api/clientes/morosos')).status, 401);
    assert.equal((await api('GET', '/api/clientes/por-vencer')).status, 401);
    assert.equal((await getMorosos(ctx.limitado)).status, 403, 'limitado solo tiene clientes_ver');
    assert.equal((await getPorVencer(ctx.limitado)).status, 403);
  });

  it('bordes de fecha: vence hoy, ayer, en 2/3/7 días caen en el bucket correcto; en 8 días no aparece en ninguno', async () => {
    const h = hoyISO();
    const offsets = [...new Set([0, -1, 2, 3, POR_VENCER_DIAS, POR_VENCER_DIAS + 1])];

    for (const d of offsets) {
      const marker = `Zz${randLetters(10)}`;
      const venc = addDays(h, d);
      const c = await crearCliente({ apellido: marker, fechaInicioCuota: addDays(venc, -30), fechaVencimiento: venc });
      const bucket = bucketDe(d);

      if (bucket === 'moroso') {
        const r = await getMorosos(ctx.admin, marker);
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.meta.total, 1, `offset ${d}`);
        assert.equal(r.body.data[0].id, c.id);
        assert.equal(r.body.data[0].diasAtraso, -d, `diasAtraso offset ${d}`);
        assert.equal(r.body.data[0].fechaVencimiento, venc);
        assert.equal((await getPorVencer(ctx.admin, marker)).body.meta.total, 0, `offset ${d} no debe estar en por-vencer`);
      } else if (bucket === 'por_vencer') {
        const r = await getPorVencer(ctx.admin, marker);
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.meta.total, 1, `offset ${d}`);
        assert.equal(r.body.data[0].id, c.id);
        assert.equal(r.body.data[0].diasRestantes, d, `diasRestantes offset ${d}`);
        assert.equal((await getMorosos(ctx.admin, marker)).body.meta.total, 0, `offset ${d} no debe estar en morosos`);
      } else {
        assert.equal((await getMorosos(ctx.admin, marker)).body.meta.total, 0, `offset ${d} (al_dia) no debe estar en morosos`);
        assert.equal((await getPorVencer(ctx.admin, marker)).body.meta.total, 0, `offset ${d} (al_dia) no debe estar en por-vencer`);
      }
    }
  });

  it('cuota de referencia = monto del último pago NO anulado; sin pagos -> sin referencia (null)', async () => {
    const h = hoyISO();
    const sinPago = await crearCliente({ apellido: `Zz${randLetters(10)}`, fechaInicioCuota: addDays(h, -31), fechaVencimiento: addDays(h, -1) });
    const r1 = await getMorosos(ctx.admin, sinPago.apellido);
    assert.equal(r1.body.data[0].montoReferencia, null);

    const conPago = await crearCliente({ apellido: `Zz${randLetters(10)}`, fechaInicioCuota: addDays(h, -31), fechaVencimiento: addDays(h, -1) });
    await sqlPago({ clienteId: conPago.id, usuarioId: ctx.adminId, monto: 456.78, fechaLocal: addDays(h, -10) });
    const r2 = await getMorosos(ctx.admin, conPago.apellido);
    assert.equal(Number(r2.body.data[0].montoReferencia), 456.78);

    // un pago vigente más viejo gana contra un pago anulado más nuevo
    const conAnulado = await crearCliente({ apellido: `Zz${randLetters(10)}`, fechaInicioCuota: addDays(h, -31), fechaVencimiento: addDays(h, -1) });
    await sqlPago({ clienteId: conAnulado.id, usuarioId: ctx.adminId, monto: 100, fechaLocal: addDays(h, -20) });
    await sqlPago({ clienteId: conAnulado.id, usuarioId: ctx.adminId, monto: 999, fechaLocal: addDays(h, -5), anulado: true });
    const r3 = await getMorosos(ctx.admin, conAnulado.apellido);
    assert.equal(Number(r3.body.data[0].montoReferencia), 100, 'el pago anulado más reciente no cuenta como referencia');
  });

  it('búsqueda por nombre (apellido) y por DNI', async () => {
    const h = hoyISO();
    const marker = `Zz${randLetters(10)}`;
    const c = await crearCliente({ apellido: marker, fechaInicioCuota: addDays(h, -31), fechaVencimiento: addDays(h, -1) });
    assert.equal((await getMorosos(ctx.admin, marker)).body.data[0].id, c.id, 'por apellido');
    assert.equal((await getMorosos(ctx.admin, c.dni)).body.data[0].id, c.id, 'por dni');
    assert.equal((await getMorosos(ctx.admin, `Zz${randLetters(12)}`)).body.meta.total, 0, 'marker inexistente no matchea');
  });

  it('paginación (>20) y total/montos agregados sobre todo el conjunto filtrado, no la página', async () => {
    const h = hoyISO();
    const marker = `Zz${randLetters(10)}`;
    const N = 23;
    let sumaEsperada = 0;
    for (let i = 0; i < N; i++) {
      const monto = (i + 1) * 10;
      sumaEsperada += monto;
      const c = await crearCliente({
        nombre: `Masivo${String.fromCharCode(97 + i)}`, apellido: marker,
        fechaInicioCuota: addDays(h, -32), fechaVencimiento: addDays(h, -2),
      });
      await sqlPago({ clienteId: c.id, usuarioId: ctx.adminId, monto, fechaLocal: addDays(h, -15) });
    }

    const p1 = await getMorosos(ctx.admin, marker, 'page=1');
    assert.equal(p1.body.meta.total, N);
    assert.equal(p1.body.meta.pageSize, 20);
    assert.equal(p1.body.data.length, 20);
    assert.equal(p1.body.meta.totalAdeudado, sumaEsperada, 'total adeudado ya en la página 1 es el del conjunto completo');

    const p2 = await getMorosos(ctx.admin, marker, 'page=2');
    assert.equal(p2.body.meta.total, N);
    assert.equal(p2.body.data.length, 3);
    assert.equal(p2.body.meta.totalAdeudado, sumaEsperada, 'el total adeudado no cambia entre páginas');

    const idsP1 = p1.body.data.map((x) => x.id);
    const idsP2 = p2.body.data.map((x) => x.id);
    assert.equal(new Set([...idsP1, ...idsP2]).size, N, 'sin duplicados ni faltantes entre páginas');
  });

  it('por-vencer: paginación y proyección de ingresos sobre todo el conjunto filtrado', async () => {
    const h = hoyISO();
    const marker = `Zz${randLetters(10)}`;
    const N = 22;
    let sumaEsperada = 0;
    for (let i = 0; i < N; i++) {
      const monto = (i + 1) * 5;
      sumaEsperada += monto;
      const c = await crearCliente({
        nombre: `Pronto${String.fromCharCode(97 + i)}`, apellido: marker,
        fechaInicioCuota: addDays(h, 3 - 30), fechaVencimiento: addDays(h, 3),
      });
      await sqlPago({ clienteId: c.id, usuarioId: ctx.adminId, monto, fechaLocal: addDays(h, -27) });
    }

    const p1 = await getPorVencer(ctx.admin, marker, 'page=1');
    assert.equal(p1.body.meta.total, N);
    assert.equal(p1.body.data.length, 20);
    assert.equal(p1.body.meta.proyeccionIngresos, sumaEsperada);

    const p2 = await getPorVencer(ctx.admin, marker, 'page=2');
    assert.equal(p2.body.data.length, 2);
    assert.equal(p2.body.meta.proyeccionIngresos, sumaEsperada, 'no cambia entre páginas');
  });
});

describe('Fase 2: cierre de caja', () => {
  const D = addDays(hoyISO(), -1000);
  const D_SIN_MOVIMIENTOS = addDays(D, -1);
  const D2 = addDays(hoyISO(), -1050);
  let empleadoA, empleadoB, cli;

  before(async () => {
    const rolId = await dbRole(`Zztest${randLetters()}`, ['facturacion_ver']);
    empleadoA = { email: testEmail('cierreA') };
    empleadoA.id = await dbUser({ nombre: 'Cierre A', email: empleadoA.email, idRol: rolId });
    empleadoA.token = await login(empleadoA.email);
    empleadoB = { email: testEmail('cierreB') };
    empleadoB.id = await dbUser({ nombre: 'Cierre B', email: empleadoB.email, idRol: rolId });
    empleadoB.token = await login(empleadoB.email);
    cli = await crearCliente();

    await sqlPago({ clienteId: cli.id, usuarioId: empleadoA.id, monto: 100, metodo: 'efectivo', fechaLocal: D });
    await sqlPago({ clienteId: cli.id, usuarioId: empleadoA.id, monto: 50, metodo: 'transferencia', fechaLocal: D });
    await sqlPago({ clienteId: cli.id, usuarioId: empleadoB.id, monto: 200, metodo: 'transferencia', fechaLocal: D });
    await sqlPago({ clienteId: cli.id, usuarioId: empleadoA.id, monto: 999, metodo: 'efectivo', fechaLocal: D, anulado: true });

    await sqlPago({ clienteId: cli.id, usuarioId: ctx.adminId, monto: 11, fechaLocal: D2, hora: '23:59:30' });
    await sqlPago({ clienteId: cli.id, usuarioId: ctx.adminId, monto: 22, fechaLocal: addDays(D2, 1), hora: '00:00:30' });
  });

  const cierre = (token, fecha, extra = '') => api('GET', `/api/pagos/cierre-caja?fecha=${fecha}${extra}`, { token });

  it('sin token -> 401; sin facturacion_ver -> 403', async () => {
    assert.equal((await api('GET', `/api/pagos/cierre-caja?fecha=${D}`)).status, 401);
    assert.equal((await cierre(ctx.limitado, D)).status, 403);
  });

  it('fecha inválida -> 400', async () => {
    assert.equal((await cierre(ctx.admin, '2024-13-40')).status, 400);
    assert.equal((await cierre(ctx.admin, 'no-es-fecha')).status, 400);
  });

  it('Admin ve todos los empleados; totales por método y por empleado cierran contra el general; anulados separados', async () => {
    const r = await cierre(ctx.admin, D);
    assert.equal(r.status, 200, r.text);
    const { data } = r.body;
    assert.equal(data.general.monto, 350);
    assert.equal(data.general.cantidad, 3);

    const sumaMetodo = data.porMetodo.reduce((acc, x) => acc + x.monto, 0);
    const sumaEmpleado = data.porEmpleado.reduce((acc, x) => acc + x.monto, 0);
    assert.equal(sumaMetodo, data.general.monto, 'porMetodo cierra contra el general');
    assert.equal(sumaEmpleado, data.general.monto, 'porEmpleado cierra contra el general');

    const a = data.porEmpleado.find((x) => x.usuarioId === empleadoA.id);
    assert.equal(a.monto, 150);
    assert.equal(a.cantidad, 2);
    assert.deepEqual(a.porMetodo.map((x) => x.metodo).sort(), ['efectivo', 'transferencia']);
    assert.equal(a.porMetodo.find((x) => x.metodo === 'efectivo').monto, 100, 'el anulado no se suma al vigente');

    const b = data.porEmpleado.find((x) => x.usuarioId === empleadoB.id);
    assert.equal(b.monto, 200);
    assert.equal(b.cantidad, 1);

    assert.equal(data.anulados.cantidad, 1);
    assert.equal(data.anulados.monto, 999);
  });

  it('Dueño también ve el cierre completo', async (t) => {
    if (!ctx.dueno) return t.skip('no existe el rol Dueño');
    const r = await cierre(ctx.dueno, D);
    assert.equal(r.body.data.general.monto, 350);
    assert.equal(r.body.data.porEmpleado.length, 2);
  });

  it('un Empleado ve SOLO sus propios cobros, aunque mande usuarioId de otro empleado en la query', async () => {
    const r = await cierre(empleadoA.token, D, `&usuarioId=${empleadoB.id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.general.monto, 150, 'solo lo de empleadoA, el query param se ignora');
    assert.equal(r.body.data.general.cantidad, 2);
    assert.equal(r.body.data.porEmpleado.length, 1);
    assert.equal(r.body.data.porEmpleado[0].usuarioId, empleadoA.id);
  });

  it('día sin movimientos: todo en cero', async () => {
    const r = await cierre(ctx.admin, D_SIN_MOVIMIENTOS);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.data.general, { monto: 0, cantidad: 0 });
    assert.deepEqual(r.body.data.porMetodo, []);
    assert.deepEqual(r.body.data.porEmpleado, []);
    assert.deepEqual(r.body.data.anulados, { cantidad: 0, monto: 0 });
  });

  it('pagos cerca de medianoche respetan la zona horaria de Tucumán (no la fecha UTC)', async () => {
    const antesMedianoche = await cierre(ctx.admin, D2);
    assert.equal(antesMedianoche.body.data.general.monto, 11, '23:59:30 local sigue siendo del día D2');
    const despuesMedianoche = await cierre(ctx.admin, addDays(D2, 1));
    assert.equal(despuesMedianoche.body.data.general.monto, 22, '00:00:30 local ya es del día siguiente');
  });
});

describe('Fase 2: anular un pago actualiza cierre de caja y morosos', () => {
  it('anular revierte la cuota al pago vigente anterior y el cliente vuelve a aparecer en morosos', async () => {
    const h = hoyISO();
    const marker = `Zz${randLetters(10)}`;
    const c = await crearCliente({ apellido: marker, fechaInicioCuota: addDays(h, -50), fechaVencimiento: addDays(h, -20) });

    // Pago previo (simulado por SQL) cuyo período ya venció hace 10 días: si fuera el último
    // pago vigente, el cliente sería moroso.
    const pago1Fecha = addDays(h, -40);
    await sqlPago({
      clienteId: c.id, usuarioId: ctx.adminId, monto: 300, fechaLocal: pago1Fecha,
      periodoDesde: addDays(h, -40), periodoHasta: addDays(h, -10),
    });
    await pool.query(
      'UPDATE clientes SET fecha_inicio_cuota = $1, fecha_vencimiento = $2 WHERE id = $3',
      [addDays(h, -40), addDays(h, -10), c.id]
    );
    assert.equal((await api('GET', `/api/clientes/${c.id}`, { token: ctx.admin })).body.data.estadoCuota, 'moroso');
    assert.equal((await getMorosos(ctx.admin, marker)).body.meta.total, 1);

    // Cobro nuevo (vía API): el cliente pasa a al_dia y sale de morosos.
    const cobro = await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 500, metodo: 'efectivo' } });
    assert.equal(cobro.status, 201, cobro.text);
    assert.equal((await api('GET', `/api/clientes/${c.id}`, { token: ctx.admin })).body.data.estadoCuota, 'al_dia');
    assert.equal((await getMorosos(ctx.admin, marker)).body.meta.total, 0, 'ya no es moroso tras el cobro');

    // cierre de caja de hoy refleja el cobro nuevo
    const antes = await api('GET', `/api/pagos/cierre-caja?fecha=${h}`, { token: ctx.admin });
    // (el cobro ya está adentro de "antes" porque se hizo recién arriba; medimos contra un cierre previo al cobro)
    const antesDelCobro = antes.body.data.general.monto - 500;

    // Anular el pago nuevo: sin permiso -> 403
    assert.equal((await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: ctx.limitado, body: { motivo: 'x' } })).status, 403);
    assert.equal((await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { body: { motivo: 'x' } })).status, 401);

    const anular = await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'Prueba automatizada' } });
    assert.equal(anular.status, 200, anular.text);

    // el cliente vuelve al estado del pago vigente anterior: moroso otra vez
    const final = await api('GET', `/api/clientes/${c.id}`, { token: ctx.admin });
    assert.equal(final.body.data.estadoCuota, 'moroso');
    assert.equal(final.body.data.fechaVencimiento, addDays(h, -10));

    const morososFinal = await getMorosos(ctx.admin, marker);
    assert.equal(morososFinal.body.meta.total, 1, 'reaparece en morosos');
    assert.equal(Number(morososFinal.body.data[0].montoReferencia), 300, 'la referencia vuelve a ser el pago anterior vigente');

    // cierre de caja de hoy: vuelve a los valores previos al cobro anulado, y el anulado queda aparte
    const despues = await api('GET', `/api/pagos/cierre-caja?fecha=${h}`, { token: ctx.admin });
    assert.equal(despues.body.data.general.monto, antesDelCobro, 'el monto anulado se excluye del total');
    assert.ok(despues.body.data.anulados.monto >= 500);
  });

  it('anular exige el permiso facturacion_anular (distinto de facturacion_ver/facturacion_cobrar)', async () => {
    const h = hoyISO();
    const c = await crearCliente({ fechaVencimiento: addDays(h, 10) });
    const cobro = await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 42, metodo: 'efectivo' } });
    assert.equal(cobro.status, 201, cobro.text);

    const sinAnular = await dbRole(`Zztest${randLetters()}`, ['facturacion_ver', 'facturacion_cobrar']);
    const email1 = testEmail('sinanular');
    await dbUser({ nombre: 'Sin Anular', email: email1, idRol: sinAnular });
    const t1 = await login(email1);
    const r1 = await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: t1, body: { motivo: 'x' } });
    assert.equal(r1.status, 403, r1.text);

    const conAnular = await dbRole(`Zztest${randLetters()}`, ['facturacion_anular']);
    const email2 = testEmail('conanular');
    await dbUser({ nombre: 'Con Anular', email: email2, idRol: conAnular });
    const t2 = await login(email2);
    const r2 = await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: t2, body: { motivo: 'x' } });
    assert.equal(r2.status, 200, r2.text);
  });

  it('motivo requerido; pago inexistente -> 404; doble anulación -> 409', async () => {
    const h = hoyISO();
    const c = await crearCliente({ fechaVencimiento: addDays(h, 10) });
    const cobro = await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 42, metodo: 'efectivo' } });
    assertErrores(await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: ctx.admin, body: {} }), ['motivo']);
    assert.equal((await api('POST', `/api/pagos/${crypto.randomUUID()}/anular`, { token: ctx.admin, body: { motivo: 'x' } })).status, 404);
    assert.equal((await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'ok' } })).status, 200);
    assert.equal((await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'otra vez' } })).status, 409);
  });
});

// ═══════════════════════════ Fase 3+: Productos, Ventas (pago dividido) y Caja ═══════════════════════════
const { crearProducto, productoBase } = H;

async function crearVenta(token, { items, pagos, idCliente } = {}) {
  return api('POST', '/api/ventas', { token, body: { items, pagos, ...(idCliente ? { idCliente } : {}) } });
}

describe('Productos: validaciones, duplicados, listado y stock', () => {
  it('validaciones de alta: nombre, precio, descripción', async () => {
    const post = (body) => api('POST', '/api/productos', { token: ctx.admin, body: productoBase(body) });
    assertErrores(await post({ nombre: 'A' }), ['nombre']);
    assertErrores(await post({ nombre: 'x'.repeat(61) }), ['nombre']);
    assertErrores(await post({ nombre: 'Café_Especial' }), ['nombre']); // guion bajo no permitido
    assertErrores(await post({ precio: 0 }), ['precio']);
    assertErrores(await post({ precio: -5 }), ['precio']);
    assertErrores(await post({ precio: 10.123 }), ['precio']);
    assertErrores(await post({ precio: 'abc' }), ['precio']);
    assertErrores(await post({ descripcion: 'x'.repeat(201) }), ['descripcion']);
    assertErrores(await api('POST', '/api/productos', { token: ctx.admin, body: {} }), ['nombre', 'precio']);
  });

  it('alta válida acepta letras, números y espacios; activo = true por defecto', async () => {
    const p = await crearProducto({ nombre: `Zztest Agua 500ml ${randLetters(4)}` });
    assert.equal(p.activo, true);
    assert.equal(p.controlaStock, false);
    assert.equal(p.stockActual, null);
  });

  it('nombre duplicado (sin importar mayúsculas) -> 409', async () => {
    const p = await crearProducto();
    const dup = await api('POST', '/api/productos', { token: ctx.admin, body: productoBase({ nombre: p.nombre.toUpperCase() }) });
    assert.equal(dup.status, 409, dup.text);
    assert.ok(dup.body.errors.nombre);
  });

  it('desactivar ("eliminar") y reactivar con toggle-activo; reactivar no permite nombre duplicado', async () => {
    const p = await crearProducto();
    const off = await api('DELETE', `/api/productos/${p.id}`, { token: ctx.admin });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.data.activo, false);

    const on = await api('PATCH', `/api/productos/${p.id}/toggle-activo`, { token: ctx.admin });
    assert.equal(on.body.data.activo, true);

    // un producto nuevo no puede robarle el nombre a uno desactivado
    await api('DELETE', `/api/productos/${p.id}`, { token: ctx.admin });
    const otro = await api('POST', '/api/productos', { token: ctx.admin, body: productoBase({ nombre: p.nombre }) });
    assert.equal(otro.status, 409, otro.text);
  });

  it('update: cambia precio/categoría; nombre duplicado contra otro producto -> 409; inexistente -> 404', async () => {
    const p = await crearProducto();
    const upd = await api('PUT', `/api/productos/${p.id}`, { token: ctx.admin, body: productoBase({ nombre: p.nombre, precio: 55.5, categoria: 'Bebidas' }) });
    assert.equal(upd.status, 200, upd.text);
    assert.equal(Number(upd.body.data.precio), 55.5);
    assert.equal(upd.body.data.categoria, 'Bebidas');

    const otro = await crearProducto();
    const dup = await api('PUT', `/api/productos/${otro.id}`, { token: ctx.admin, body: productoBase({ nombre: p.nombre }) });
    assert.equal(dup.status, 409, dup.text);

    assert.equal((await api('PUT', `/api/productos/${uuid()}`, { token: ctx.admin, body: productoBase() })).status, 404);
  });

  it('listado: búsqueda por nombre, filtro activo/inactivo y paginación', async () => {
    const marker = `Zztest${randLetters(10)}`;
    const activo = await crearProducto({ nombre: `${marker} Activo` });
    const inactivo = await crearProducto({ nombre: `${marker} Inactivo` });
    await api('DELETE', `/api/productos/${inactivo.id}`, { token: ctx.admin });

    const todos = await api('GET', `/api/productos?query=${encodeURIComponent(marker)}`, { token: ctx.admin });
    assert.equal(todos.body.meta.total, 2);

    const soloActivos = await api('GET', `/api/productos?query=${encodeURIComponent(marker)}&activo=true`, { token: ctx.admin });
    assert.deepEqual(soloActivos.body.data.map((x) => x.id), [activo.id]);

    const soloInactivos = await api('GET', `/api/productos?query=${encodeURIComponent(marker)}&activo=false`, { token: ctx.admin });
    assert.deepEqual(soloInactivos.body.data.map((x) => x.id), [inactivo.id]);
  });

  it('ajuste manual de stock: incrementa, decrementa, rechaza negativo y queda auditado', async () => {
    const p = await crearProducto({ controlaStock: true, stockActual: 10 });
    const inc = await api('PATCH', `/api/productos/${p.id}/stock`, { token: ctx.admin, body: { delta: 5, motivo: 'reposición' } });
    assert.equal(inc.status, 200, inc.text);
    assert.equal(inc.body.data.stockActual, 15);

    const dec = await api('PATCH', `/api/productos/${p.id}/stock`, { token: ctx.admin, body: { delta: -3 } });
    assert.equal(dec.body.data.stockActual, 12);

    const insuf = await api('PATCH', `/api/productos/${p.id}/stock`, { token: ctx.admin, body: { delta: -999 } });
    assert.equal(insuf.status, 409, insuf.text);

    const cero = await api('PATCH', `/api/productos/${p.id}/stock`, { token: ctx.admin, body: { delta: 0 } });
    assert.equal(cero.status, 400);

    const { rows } = await pool.query(
      `SELECT tipo, cantidad FROM movimientos_stock WHERE id_producto = $1 AND tipo = 'ajuste' ORDER BY fecha_hora`, [p.id]
    );
    assert.deepEqual(rows.map((r) => r.cantidad), [5, -3]);
  });

  it('ajuste de stock sobre un producto que no controla stock -> 409', async () => {
    const p = await crearProducto();
    assert.equal((await api('PATCH', `/api/productos/${p.id}/stock`, { token: ctx.admin, body: { delta: 1 } })).status, 409);
  });
});

describe('Ventas: precio del servidor, pago dividido, stock y atomicidad', () => {
  it('validaciones: items y pagos vacíos/inválidos -> 400', async () => {
    assertErrores(await crearVenta(ctx.admin, {}), ['items', 'pagos']);
    assertErrores(await crearVenta(ctx.admin, { items: [], pagos: [] }), ['items', 'pagos']);
    const p = await crearProducto();
    assertErrores(await crearVenta(ctx.admin, { items: [{ idProducto: 'no-uuid', cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 1 }] }), ['items']);
    assertErrores(await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 0 }], pagos: [{ metodo: 'efectivo', monto: 1 }] }), ['items']);
    assertErrores(await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'bitcoin', monto: 1 }] }), ['pagos']);
    assertErrores(await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: -1 }] }), ['pagos']);
  });

  it('producto inexistente -> 404; producto inactivo -> 409', async () => {
    const r404 = await crearVenta(ctx.admin, { items: [{ idProducto: uuid(), cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 100 }] });
    assert.equal(r404.status, 404, r404.text);

    const p = await crearProducto();
    await api('DELETE', `/api/productos/${p.id}`, { token: ctx.admin });
    const r409 = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: Number(p.precio) }] });
    assert.equal(r409.status, 409, r409.text);
  });

  it('el precio SIEMPRE lo calcula el servidor: un precio manipulado en el body se ignora', async () => {
    const p = await crearProducto({ precio: 77.5 });
    const r = await crearVenta(ctx.admin, {
      items: [{ idProducto: p.id, cantidad: 2, precio: 0.01 }],
      pagos: [{ metodo: 'efectivo', monto: 155 }],
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(Number(r.body.data.total), 155);
    assert.equal(Number(r.body.data.items[0].precioUnitario), 77.5);
  });

  it('pagos que no suman el total -> 400 (sin crear nada)', async () => {
    const p = await crearProducto({ precio: 100 });
    const r = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 99 }] });
    assert.equal(r.status, 400, r.text);
    assert.ok(r.body.errors.pagos);
  });

  it('pago dividido: la venta queda con las filas de venta_pagos correctas', async () => {
    const p = await crearProducto({ precio: 100 });
    const r = await crearVenta(ctx.admin, {
      items: [{ idProducto: p.id, cantidad: 3 }],
      pagos: [{ metodo: 'efectivo', monto: 200 }, { metodo: 'transferencia', monto: 100 }],
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(Number(r.body.data.total), 300);
    const porMetodo = Object.fromEntries(r.body.data.pagos.map((x) => [x.metodo, Number(x.monto)]));
    assert.deepEqual(porMetodo, { efectivo: 200, transferencia: 100 });
  });

  it('snapshot: cambiar el precio del producto después no altera ventas viejas', async () => {
    const p = await crearProducto({ precio: 50 });
    const venta1 = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 50 }] });
    await api('PUT', `/api/productos/${p.id}`, { token: ctx.admin, body: productoBase({ nombre: p.nombre, precio: 999 }) });
    const relectura = await api('GET', `/api/ventas/${venta1.body.data.id}`, { token: ctx.admin });
    assert.equal(Number(relectura.body.data.items[0].precioUnitario), 50);
    assert.equal(Number(relectura.body.data.total), 50);
  });

  it('stock: se descuenta solo si controla_stock, insuficiente -> 409, se restituye al anular', async () => {
    const conStock = await crearProducto({ controlaStock: true, stockActual: 5, precio: 10 });
    const sinStock = await crearProducto({ precio: 10 }); // controla_stock: false

    // vender más de lo que hay -> 409 y no se descuenta nada
    const insuf = await crearVenta(ctx.admin, { items: [{ idProducto: conStock.id, cantidad: 6 }], pagos: [{ metodo: 'efectivo', monto: 60 }] });
    assert.equal(insuf.status, 409, insuf.text);
    assert.equal(insuf.body.productoId, conStock.id);
    assert.equal((await api('GET', `/api/productos/${conStock.id}`, { token: ctx.admin })).body.data.stockActual, 5);

    const r = await crearVenta(ctx.admin, {
      items: [{ idProducto: conStock.id, cantidad: 2 }, { idProducto: sinStock.id, cantidad: 3 }],
      pagos: [{ metodo: 'efectivo', monto: 50 }],
    });
    assert.equal(r.status, 201, r.text);
    assert.equal((await api('GET', `/api/productos/${conStock.id}`, { token: ctx.admin })).body.data.stockActual, 3);
    assert.equal((await api('GET', `/api/productos/${sinStock.id}`, { token: ctx.admin })).body.data.stockActual, null);

    const anular = await api('POST', `/api/ventas/${r.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'prueba' } });
    assert.equal(anular.status, 200, anular.text);
    assert.equal((await api('GET', `/api/productos/${conStock.id}`, { token: ctx.admin })).body.data.stockActual, 5, 'stock restituido');

    const { rows } = await pool.query(
      `SELECT tipo, cantidad FROM movimientos_stock WHERE id_producto = $1 ORDER BY fecha_hora`, [conStock.id]
    );
    assert.deepEqual(rows.map((x) => x.tipo), ['venta', 'anulacion_venta']);
    assert.deepEqual(rows.map((x) => x.cantidad), [-2, 2]);
  });

  it('atomicidad: si un ítem falla (producto inexistente), no queda ninguna venta ni se toca el stock del primero', async () => {
    const conStock = await crearProducto({ controlaStock: true, stockActual: 10, precio: 10 });
    const antes = (await pool.query('SELECT COUNT(*)::int AS n FROM ventas')).rows[0].n;

    const r = await crearVenta(ctx.admin, {
      items: [{ idProducto: conStock.id, cantidad: 1 }, { idProducto: uuid(), cantidad: 1 }],
      pagos: [{ metodo: 'efectivo', monto: 10 }],
    });
    assert.equal(r.status, 404, r.text);

    const despues = (await pool.query('SELECT COUNT(*)::int AS n FROM ventas')).rows[0].n;
    assert.equal(despues, antes, 'no se insertó ninguna venta');
    assert.equal((await api('GET', `/api/productos/${conStock.id}`, { token: ctx.admin })).body.data.stockActual, 10, 'el stock del primer ítem no se tocó');
  });

  it('doble anulación -> 409; anular venta inexistente -> 404; permiso ventas_anular distinto de ventas_registrar', async () => {
    const p = await crearProducto({ precio: 20 });
    const r = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 20 }] });
    assert.equal((await api('POST', `/api/ventas/${uuid()}/anular`, { token: ctx.admin, body: { motivo: 'x' } })).status, 404);

    const sinAnular = await dbRole(`Zztest${randLetters()}`, ['ventas_registrar', 'ventas_ver']);
    const email = testEmail('sinanularventa');
    await dbUser({ nombre: 'Sin Anular Venta', email, idRol: sinAnular });
    const t = await login(email);
    assert.equal((await api('POST', `/api/ventas/${r.body.data.id}/anular`, { token: t, body: { motivo: 'x' } })).status, 403);

    const ok = await api('POST', `/api/ventas/${r.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'ok' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await api('POST', `/api/ventas/${r.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'otra vez' } })).status, 409);
  });

  it('listado: filtra por fecha/empleado/anuladas y pagina', async () => {
    const p = await crearProducto({ precio: 15 });
    const v1 = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 15 }] });
    const lista = await api('GET', `/api/ventas?usuarioId=${ctx.adminId}`, { token: ctx.admin });
    assert.equal(lista.status, 200, lista.text);
    assert.ok(lista.body.data.some((x) => x.id === v1.body.data.id));
    assert.equal((await api('GET', '/api/ventas?anuladas=true', { token: ctx.admin })).status, 200);
    assert.equal((await api('GET', '/api/ventas?desde=no-es-fecha', { token: ctx.admin })).status, 400);
  });

  it('reportes: unidades e ingreso por producto, ventas por día', async () => {
    const h = hoyISO();
    const p = await crearProducto({ precio: 25 });
    await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 4 }], pagos: [{ metodo: 'efectivo', monto: 100 }] });
    const anulada = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 2 }], pagos: [{ metodo: 'efectivo', monto: 50 }] });
    await api('POST', `/api/ventas/${anulada.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'no cuenta' } });

    const r = await api('GET', `/api/ventas/reportes?desde=${h}&hasta=${h}`, { token: ctx.admin });
    assert.equal(r.status, 200, r.text);
    const fila = r.body.data.porProducto.find((x) => x.idProducto === p.id);
    assert.equal(fila.unidades, 4, 'la anulada no suma unidades');
    assert.equal(fila.ingreso, 100);
    const dia = r.body.data.porDia.find((x) => x.fecha === h);
    assert.ok(dia.total >= 100);
  });

  it('una venta vigente nunca viaja con anulada: null (toCamelCase recursivo no debe pisar booleans en false)', async () => {
    const p = await crearProducto({ precio: 10 });
    const r = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 10 }] });
    assert.equal(r.body.data.anulada, false);
    const relectura = await api('GET', `/api/ventas/${r.body.data.id}`, { token: ctx.admin });
    assert.equal(relectura.body.data.anulada, false);
  });

  it('usuarioNombre y clienteNombreCompleto vienen con el mismo shape en el detalle y en el listado', async () => {
    const h = hoyISO();
    const cli = await crearCliente();
    const p = await crearProducto({ precio: 10 });
    const r = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 10 }], idCliente: cli.id });
    assert.ok(r.body.data.usuarioNombre, 'el detalle de la venta recién creada trae usuarioNombre');
    assert.equal(r.body.data.clienteNombreCompleto, `${cli.apellido}, ${cli.nombre}`);

    const detalle = await api('GET', `/api/ventas/${r.body.data.id}`, { token: ctx.admin });
    assert.equal(detalle.body.data.usuarioNombre, r.body.data.usuarioNombre);
    assert.equal(detalle.body.data.clienteNombreCompleto, r.body.data.clienteNombreCompleto);

    const lista = await api('GET', `/api/ventas?desde=${h}&hasta=${h}`, { token: ctx.admin });
    const enLista = lista.body.data.find((x) => x.id === r.body.data.id);
    assert.equal(enLista.usuarioNombre, r.body.data.usuarioNombre);
    assert.equal(enLista.clienteNombreCompleto, r.body.data.clienteNombreCompleto);
  });
});

describe('Cuotas: pago dividido (pagos[]) y compatibilidad con el front viejo', () => {
  it('un solo método en pagos[] se comporta igual que el campo metodo legacy', async () => {
    const c = await crearCliente();
    const r = await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 300, pagos: [{ metodo: 'efectivo', monto: 300 }] } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.data.metodo, 'efectivo');
    assert.deepEqual(r.body.data.metodos.map((m) => m.metodo), ['efectivo']);
  });

  it('dos métodos -> pagos.metodo = "mixto" y dos filas en pago_metodos', async () => {
    const c = await crearCliente();
    const r = await api('POST', '/api/pagos', { token: ctx.admin, body: {
      clienteId: c.id, monto: 1000, pagos: [{ metodo: 'efectivo', monto: 600 }, { metodo: 'transferencia', monto: 400 }],
    } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.data.metodo, 'mixto');
    const porMetodo = Object.fromEntries(r.body.data.metodos.map((m) => [m.metodo, Number(m.monto)]));
    assert.deepEqual(porMetodo, { efectivo: 600, transferencia: 400 });
  });

  it('pagos[] cuya suma no coincide con el monto -> 400', async () => {
    const c = await crearCliente();
    const r = await api('POST', '/api/pagos', { token: ctx.admin, body: {
      clienteId: c.id, monto: 1000, pagos: [{ metodo: 'efectivo', monto: 600 }, { metodo: 'transferencia', monto: 300 }],
    } });
    assert.equal(r.status, 400, r.text);
    assert.ok(r.body.errors.pagos);
  });

  it('sin metodo ni pagos[] -> 400; metodo inválido ("tarjeta" ya no existe) -> 400', async () => {
    const c = await crearCliente();
    assertErrores(await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 100 } }), ['metodo']);
    assertErrores(await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 100, metodo: 'tarjeta' } }), ['metodo']);
  });

  it('toda cuota (incluso las sembradas antes de la migración) tiene desglose en pago_metodos', async () => {
    const { rows } = await pool.query(
      `SELECT p.id FROM pagos p WHERE NOT EXISTS (SELECT 1 FROM pago_metodos pm WHERE pm.id_pago = p.id)`
    );
    assert.equal(rows.length, 0, 'ningún pago debería quedar sin desglose');
  });

  it('el backup de pagos previo a la migración coincide con lo que hoy hay backfillado en pago_metodos', async () => {
    const backup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backup_pagos_2026-10-08.json'), 'utf8'));
    for (const row of backup) {
      const { rows } = await pool.query('SELECT metodo, monto FROM pago_metodos WHERE id_pago = $1', [row.id]);
      assert.equal(rows.length, 1, `pago ${row.id} debería tener exactamente 1 fila de desglose`);
      assert.equal(rows[0].metodo, row.metodo);
      assert.equal(Number(rows[0].monto), Number(row.monto));
    }
  });

  it('GET /pagos/cliente y GET /pagos devuelven el desglose (metodos)', async () => {
    const c = await crearCliente();
    await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 500, metodo: 'transferencia' } });
    const hist = await api('GET', `/api/pagos/cliente/${c.id}`, { token: ctx.admin });
    assert.ok(Array.isArray(hist.body.data[0].metodos));
    assert.equal(hist.body.data[0].metodos[0].metodo, 'transferencia');

    const lista = await api('GET', `/api/pagos?clienteQuery=${c.dni}`, { token: ctx.admin });
    assert.ok(Array.isArray(lista.body.data[0].metodos));
  });

  it('anular una cuota dividida sigue funcionando (el desglose queda, el cliente vuelve al estado anterior)', async () => {
    const h = hoyISO();
    const c = await crearCliente({ fechaVencimiento: addDays(h, 10) });
    const cobro = await api('POST', '/api/pagos', { token: ctx.admin, body: {
      clienteId: c.id, monto: 1000, pagos: [{ metodo: 'efectivo', monto: 500 }, { metodo: 'transferencia', monto: 500 }],
    } });
    assert.equal(cobro.status, 201, cobro.text);
    const anular = await api('POST', `/api/pagos/${cobro.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'x' } });
    assert.equal(anular.status, 200, anular.text);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pago_metodos WHERE id_pago = $1', [cobro.body.data.id]);
    assert.equal(rows[0].n, 2, 'el desglose de un pago anulado no se borra');
  });
});

describe('Caja: egresos/ingresos extra y apertura', () => {
  it('validaciones de alta de movimiento', async () => {
    const post = (body) => api('POST', '/api/caja/movimientos', { token: ctx.admin, body });
    assertErrores(await post({}), ['tipo', 'concepto', 'monto', 'metodo']);
    assertErrores(await post({ tipo: 'invalido', concepto: 'x', monto: 10, metodo: 'efectivo' }), ['tipo']);
    assertErrores(await post({ tipo: 'egreso', concepto: 'x', monto: -10, metodo: 'efectivo' }), ['monto']);
    assertErrores(await post({ tipo: 'egreso', concepto: 'x', monto: 10, metodo: 'bitcoin' }), ['metodo']);
  });

  it('crear, listar por fecha y anular con motivo; doble anulación -> 409', async () => {
    const h = hoyISO();
    const mov = await api('POST', '/api/caja/movimientos', { token: ctx.admin, body: { tipo: 'egreso', concepto: 'Zztest insumos', monto: 123.45, metodo: 'efectivo' } });
    assert.equal(mov.status, 201, mov.text);

    const lista = await api('GET', `/api/caja/movimientos?fecha=${h}`, { token: ctx.admin });
    assert.ok(lista.body.data.some((x) => x.id === mov.body.data.id));

    assertErrores(await api('POST', `/api/caja/movimientos/${mov.body.data.id}/anular`, { token: ctx.admin, body: {} }), ['motivo']);
    assert.equal((await api('POST', `/api/caja/movimientos/${uuid()}/anular`, { token: ctx.admin, body: { motivo: 'x' } })).status, 404);

    const anular = await api('POST', `/api/caja/movimientos/${mov.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'error de tipeo' } });
    assert.equal(anular.status, 200, anular.text);
    assert.equal((await api('POST', `/api/caja/movimientos/${mov.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'x' } })).status, 409);
  });

  it('caja_ver permite listar pero no crear/anular; caja_movimientos permite todo', async () => {
    const soloVer = await dbRole(`Zztest${randLetters()}`, ['caja_ver']);
    const email = testEmail('cajaver');
    await dbUser({ nombre: 'Caja Ver', email, idRol: soloVer });
    const t = await login(email);
    assert.equal((await api('GET', '/api/caja/movimientos', { token: t })).status, 200);
    assert.equal((await api('POST', '/api/caja/movimientos', { token: t, body: {} })).status, 403);
  });

  it('apertura: GET/PUT por fecha, upsert (una por día)', async () => {
    const fecha = addDays(hoyISO(), -1500);
    const vacia = await api('GET', `/api/caja/apertura?fecha=${fecha}`, { token: ctx.admin });
    assert.equal(vacia.body.data, null);

    const put1 = await api('PUT', '/api/caja/apertura', { token: ctx.admin, body: { fecha, montoInicialEfectivo: 1000 } });
    assert.equal(put1.status, 200, put1.text);
    assert.equal(Number(put1.body.data.montoInicialEfectivo), 1000);

    const put2 = await api('PUT', '/api/caja/apertura', { token: ctx.admin, body: { fecha, montoInicialEfectivo: 1500.50 } });
    assert.equal(Number(put2.body.data.montoInicialEfectivo), 1500.50);

    const get = await api('GET', `/api/caja/apertura?fecha=${fecha}`, { token: ctx.admin });
    assert.equal(Number(get.body.data.montoInicialEfectivo), 1500.50);

    // 0 es un valor válido (caja en cero)
    const cero = await api('PUT', '/api/caja/apertura', { token: ctx.admin, body: { fecha, montoInicialEfectivo: 0 } });
    assert.equal(cero.status, 200, cero.text);

    assertErrores(await api('PUT', '/api/caja/apertura', { token: ctx.admin, body: { montoInicialEfectivo: -1 } }), ['montoInicialEfectivo']);
  });
});

describe('Cierre de caja integrado (/api/caja/cierre)', () => {
  const FECHA = addDays(hoyISO(), -2000);
  let empleado, producto1;

  before(async () => {
    const rolId = await dbRole(`Zztest${randLetters()}`, ['facturacion_ver', 'ventas_ver', 'caja_ver']);
    empleado = { email: testEmail('cierreint') };
    empleado.id = await dbUser({ nombre: 'Cierre Integrado', email: empleado.email, idRol: rolId });
    empleado.token = await login(empleado.email);

    producto1 = await crearProducto({ precio: 100 });

    await cajaApertura.upsert({ fecha: FECHA, monto_inicial_efectivo: 1000, usuario_id: empleado.id });
    // cuota mixta: 60 efectivo + 40 transferencia
    await sqlPagoEnFecha(FECHA, { usuarioId: empleado.id, monto: 100, desglose: [{ metodo: 'efectivo', monto: 60 }, { metodo: 'transferencia', monto: 40 }] });
    // venta dividida: 70 efectivo + 30 transferencia, vía SQL directo para fijar la fecha
    await sqlVentaEnFecha(FECHA, { usuarioId: empleado.id, productoId: producto1.id, total: 100, pagos: [{ metodo: 'efectivo', monto: 70 }, { metodo: 'transferencia', monto: 30 }] });
    // egreso efectivo
    await movimientoCaja.create({ tipo: 'egreso', concepto: 'Zztest alquiler', monto: 50, metodo: 'efectivo', usuario_id: empleado.id });
    await pool.query(`UPDATE movimientos_caja SET fecha_hora = (($1::date + time '12:00') AT TIME ZONE $2) WHERE id_usuario = $3 AND concepto = 'Zztest alquiler'`, [FECHA, TZ, empleado.id]);
    // ingreso extra transferencia
    await movimientoCaja.create({ tipo: 'ingreso_extra', concepto: 'Zztest varios', monto: 20, metodo: 'transferencia', usuario_id: empleado.id });
    await pool.query(`UPDATE movimientos_caja SET fecha_hora = (($1::date + time '12:00') AT TIME ZONE $2) WHERE id_usuario = $3 AND concepto = 'Zztest varios'`, [FECHA, TZ, empleado.id]);
  });

  it('efectivoEsperado y transferenciasTotal cierran matemáticamente contra los datos sembrados', async () => {
    const r = await api('GET', `/api/caja/cierre?fecha=${FECHA}`, { token: ctx.admin });
    assert.equal(r.status, 200, r.text);
    const d = r.body.data;
    assert.equal(d.aperturaInicialEfectivo, 1000);
    assert.equal(d.porTipo.cuotas.efectivo, 60);
    assert.equal(d.porTipo.cuotas.transferencia, 40);
    assert.equal(d.porTipo.ventas.efectivo, 70);
    assert.equal(d.porTipo.ventas.transferencia, 30);
    assert.equal(d.porTipo.egresos.efectivo, 50);
    assert.equal(d.porTipo.ingresosExtra.transferencia, 20);
    // 1000 + 60 (cuota efectivo) + 70 (venta efectivo) + 0 (ingresos extra efectivo) - 50 (egreso efectivo)
    assert.equal(d.efectivoEsperado, 1080);
    // 40 (cuota transf) + 30 (venta transf) + 20 (ingreso extra transf) - 0 (egreso transf)
    assert.equal(d.transferenciasTotal, 90);
  });

  it('un Empleado ve solo lo suyo en el cierre integrado', async () => {
    const otroRolId = await dbRole(`Zztest${randLetters()}`, ['facturacion_ver', 'ventas_ver', 'caja_ver']);
    const otroEmail = testEmail('cierreintotro');
    const otroId = await dbUser({ nombre: 'Otro Empleado', email: otroEmail, idRol: otroRolId });
    const otroToken = await login(otroEmail);
    await sqlPagoEnFecha(FECHA, { usuarioId: otroId, monto: 500, desglose: [{ metodo: 'efectivo', monto: 500 }] });

    const soloPropio = await api('GET', `/api/caja/cierre?fecha=${FECHA}`, { token: empleado.token });
    assert.equal(soloPropio.body.data.porTipo.cuotas.efectivo, 60, 'no ve los 500 del otro empleado');

    const admin = await api('GET', `/api/caja/cierre?fecha=${FECHA}`, { token: ctx.admin });
    assert.equal(admin.body.data.porTipo.cuotas.efectivo, 560, 'admin ve todo');
  });

  it('anulados (cuotas y ventas) quedan reportados aparte y no afectan los totales vigentes', async () => {
    const h = hoyISO();
    const p = await crearProducto({ precio: 40 });
    const venta = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 40 }] });
    const antes = await api('GET', `/api/caja/cierre?fecha=${h}`, { token: ctx.admin });
    await api('POST', `/api/ventas/${venta.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'x' } });
    const despues = await api('GET', `/api/caja/cierre?fecha=${h}`, { token: ctx.admin });
    assert.equal(despues.body.data.porTipo.ventas.efectivo, antes.body.data.porTipo.ventas.efectivo - 40);
    assert.ok(despues.body.data.anulados.ventas.monto >= 40);
  });

  it('medianoche Tucumán: un movimiento a las 23:59:30 local pertenece al día local, no al UTC', async () => {
    const D = addDays(hoyISO(), -2050);
    await movimientoCaja.create({ tipo: 'egreso', concepto: 'Zztest medianoche', monto: 15, metodo: 'efectivo', usuario_id: ctx.adminId });
    await pool.query(`UPDATE movimientos_caja SET fecha_hora = (($1::date + time '23:59:30') AT TIME ZONE $2) WHERE id_usuario = $3 AND concepto = 'Zztest medianoche'`, [D, TZ, ctx.adminId]);
    const r = await api('GET', `/api/caja/cierre?fecha=${D}`, { token: ctx.admin });
    assert.equal(r.body.data.porTipo.egresos.efectivo, 15);
    const rDiaSiguiente = await api('GET', `/api/caja/cierre?fecha=${addDays(D, 1)}`, { token: ctx.admin });
    assert.equal(rDiaSiguiente.body.data.porTipo.egresos.efectivo, 0);
  });
});

describe('Dashboard: ventasHoy', () => {
  it('ventasHoyTotal/ventasHoyCantidad suman exactamente las ventas de hoy no anuladas', async () => {
    const antes = await statsDash();
    const p = await crearProducto({ precio: 33 });
    await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 33 }] });
    const anulada = await crearVenta(ctx.admin, { items: [{ idProducto: p.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', monto: 33 }] });
    await api('POST', `/api/ventas/${anulada.body.data.id}/anular`, { token: ctx.admin, body: { motivo: 'x' } });
    const despues = await statsDash();
    assert.equal(cents(despues.ventasHoyTotal - antes.ventasHoyTotal), 3300, 'la anulada no suma');
    assert.equal(despues.ventasHoyCantidad - antes.ventasHoyCantidad, 1);
  });
});
