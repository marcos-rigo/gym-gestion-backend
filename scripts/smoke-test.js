// Smoke test de la API. Uso: npm test
//
// - Levanta la app en un puerto libre dentro del mismo proceso (o usa TEST_BASE_URL si se define).
// - Crea sus propios usuarios/roles de prueba directo en la base: no necesita credenciales reales
//   y no toca al superadmin ni a datos existentes.
// - Marca de los datos de prueba (los campos de nombre/descripción solo admiten letras, así que
//   "TEST_" no se puede usar ahí): emails `test_*@example.test`, observaciones `TEST_...`,
//   roles `Zztest...`. Todo se borra al final, y también se barren restos de corridas anteriores.
// - Para probar la protección del superadmin, la app de prueba corre con SUPERADMIN_EMAIL apuntando
//   a un usuario de prueba; el superadmin real nunca recibe un request de escritura.

require('dotenv').config({ quiet: true });

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const external = !!process.env.TEST_BASE_URL;
const rand = (n = 6) => crypto.randomBytes(n).toString('hex').slice(0, n);
const randLetters = (n = 6) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[crypto.randomInt(26)]).join('');
const randDni = () => `99${String(crypto.randomInt(1000000)).padStart(6, '0')}`;

const PASSWORD = 'Test1234x';
const testEmail = (tag) => `test_${tag}_${rand()}@example.test`;
const protectedEmail = testEmail('protegido');
if (!external) process.env.SUPERADMIN_EMAIL = protectedEmail; // antes de cargar la app

const { pool } = require('../src/config/db');
const { hoyISO, addDays, POR_VENCER_DIAS } = require('../src/config/fechas');
const { corsOrigins } = require('../src/config/env');

let server;
let baseUrl = process.env.TEST_BASE_URL;
const ctx = { ids: { clientes: [], usuarios: [], roles: [], productos: [] } };

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* respuesta no JSON */ }
  return { status: res.status, body: json, headers: res.headers, text };
}

async function login(email, password = PASSWORD) {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, `login ${email}: ${r.text}`);
  return r.body.token;
}

async function dbUser({ nombre, email, idRol, activo = true }) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query(
    'INSERT INTO usuarios (nombre, email, password_hash, id_rol, activo) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [nombre, email, hash, idRol, activo]
  );
  ctx.ids.usuarios.push(rows[0].id);
  return rows[0].id;
}

async function dbRole(descripcion, permisos) {
  const { rows } = await pool.query('INSERT INTO roles (descripcion) VALUES ($1) RETURNING id', [descripcion]);
  if (permisos.length) {
    await pool.query(
      'INSERT INTO linea_permiso (id_rol, id_permiso) SELECT $1, id FROM permisos WHERE descripcion = ANY($2)',
      [rows[0].id, permisos]
    );
  }
  ctx.ids.roles.push(rows[0].id);
  return rows[0].id;
}

const clienteBase = (over = {}) => ({
  nombre: 'Prueba', apellido: 'Automatica', dni: randDni(),
  email: testEmail('cli'), observaciones: `TEST_${rand()}`, ...over,
});

async function crearCliente(over = {}) {
  const r = await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase(over) });
  assert.equal(r.status, 201, r.text);
  ctx.ids.clientes.push(r.body.data.id);
  return r.body.data;
}

const productoBase = (over = {}) => ({
  nombre: `Zztest${randLetters(10)}`, precio: 100, ...over,
});

async function crearProducto(over = {}) {
  const r = await api('POST', '/api/productos', { token: ctx.admin, body: productoBase(over) });
  assert.equal(r.status, 201, r.text);
  ctx.ids.productos.push(r.body.data.id);
  return r.body.data;
}

function assertErrores(r, campos) {
  assert.equal(r.status, 400, r.text);
  assert.ok(r.body.message, 'falta message');
  for (const c of campos) assert.ok(r.body.errors?.[c], `falta errors.${c}: ${r.text}`);
}

async function cleanup() {
  const emailLike = 'test\\_%@example.test';
  const q = (sql, params) => pool.query(sql, params).catch((e) => console.error('cleanup:', e.message));
  const usuariosTestSql = `(SELECT id FROM usuarios WHERE email LIKE $1)`;

  // Productos/ventas/caja: tablas nuevas de Facturación Fase 3+. movimientos_stock no tiene
  // ON DELETE CASCADE hacia ventas/productos (a propósito: en uso normal nunca se borran), así
  // que hay que vaciarlo antes de poder borrar esas filas.
  await q(`DELETE FROM movimientos_stock WHERE id_usuario IN ${usuariosTestSql}
             OR id_producto IN (SELECT id FROM productos WHERE nombre LIKE 'Zztest%' OR id = ANY($2::uuid[]))
             OR id_venta IN (SELECT id FROM ventas WHERE id_usuario IN ${usuariosTestSql})`,
    [emailLike, ctx.ids.productos]);
  await q(`DELETE FROM ventas WHERE id_usuario IN ${usuariosTestSql}`, [emailLike]); // cascada a venta_items/venta_pagos
  await q(`DELETE FROM productos WHERE nombre LIKE 'Zztest%' OR id = ANY($1::uuid[])`, [ctx.ids.productos]);
  await q(`DELETE FROM movimientos_caja WHERE id_usuario IN ${usuariosTestSql}`, [emailLike]);
  await q(`DELETE FROM caja_apertura WHERE id_usuario IN ${usuariosTestSql}`, [emailLike]);

  await q(`DELETE FROM pagos WHERE usuario_id IN (SELECT id FROM usuarios WHERE email LIKE $1)
             OR cliente_id IN (SELECT id FROM clientes WHERE email LIKE $1 OR observaciones LIKE 'TEST\\_%')`, [emailLike]);
  await q(`DELETE FROM clientes WHERE email LIKE $1 OR observaciones LIKE 'TEST\\_%' OR id = ANY($2::uuid[])`, [emailLike, ctx.ids.clientes]);
  await q(`DELETE FROM usuarios WHERE (email LIKE $1 OR id = ANY($2::uuid[])) AND lower(email) <> 'marcos.rigo.10@gmail.com'`,
    [emailLike, ctx.ids.usuarios]);
  await q(`DELETE FROM roles WHERE (descripcion LIKE 'Zztest%' OR id = ANY($1::uuid[])) AND NOT es_admin`, [ctx.ids.roles]);
}

before(async () => {
  if (!external) {
    const app = require('../app');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  await cleanup(); // restos de corridas anteriores

  const { rows: admin } = await pool.query('SELECT id FROM roles WHERE es_admin LIMIT 1');
  const { rows: dueno } = await pool.query("SELECT id FROM roles WHERE descripcion = 'Dueño' LIMIT 1");
  ctx.adminRolId = admin[0].id;
  ctx.limitadoRolId = await dbRole(`Zztest${randLetters()}`, ['clientes_ver']);
  ctx.sinPermisosRolId = await dbRole(`Zztest${randLetters()}`, []);

  ctx.adminEmail = testEmail('admin');
  ctx.adminId = await dbUser({ nombre: 'Admin Prueba', email: ctx.adminEmail, idRol: ctx.adminRolId });
  ctx.limitadoEmail = testEmail('limitado');
  await dbUser({ nombre: 'Limitado Prueba', email: ctx.limitadoEmail, idRol: ctx.limitadoRolId });
  if (dueno[0]) {
    ctx.duenoEmail = testEmail('dueno');
    await dbUser({ nombre: 'Dueno Prueba', email: ctx.duenoEmail, idRol: dueno[0].id });
  }
  ctx.protegidoId = !external
    ? await dbUser({ nombre: 'Protegido Prueba', email: protectedEmail, idRol: ctx.adminRolId })
    : null;

  ctx.admin = await login(ctx.adminEmail);
  ctx.limitado = await login(ctx.limitadoEmail);
  if (ctx.duenoEmail) ctx.dueno = await login(ctx.duenoEmail);
});

after(async () => {
  await cleanup();
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

describe('infraestructura', () => {
  it('ruta inexistente responde 404 JSON', async () => {
    const r = await api('GET', '/api/nada');
    assert.equal(r.status, 404);
    assert.ok(r.body.message);
  });

  it('JSON malformado responde 400 JSON', async () => {
    const r = await api('POST', '/api/auth/login', { raw: '{malo', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.ok(r.body.message);
  });

  it('CORS permite orígenes de CORS_ORIGIN y rechaza el resto', async () => {
    const [permitido] = corsOrigins();
    const ok = await api('GET', '/api/nada', { headers: { Origin: permitido } });
    assert.equal(ok.headers.get('access-control-allow-origin'), permitido);
    const no = await api('GET', '/api/nada', { headers: { Origin: 'http://evil.example' } });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  });
});

describe('auth', () => {
  it('login correcto devuelve token y usuario sin rol en el payload', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: ctx.adminEmail.toUpperCase(), password: PASSWORD } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.token);
    assert.equal(r.body.usuario.rol, undefined);
  });

  it('contraseña incorrecta -> 401', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: ctx.adminEmail, password: 'incorrecta1' } });
    assert.equal(r.status, 401);
  });

  it('faltan datos o tipos inválidos -> 400', async () => {
    assert.equal((await api('POST', '/api/auth/login', { body: {} })).status, 400);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: ctx.adminEmail, password: { x: 1 } } })).status, 400);
    assert.equal((await api('POST', '/api/auth/login', { raw: '', headers: {} })).status, 400);
  });

  it('mis-permisos devuelve el rol del usuario', async () => {
    const r = await api('GET', '/api/auth/mis-permisos', { token: ctx.limitado });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.data.permissions, ['clientes_ver']);
    assert.equal(r.body.data.esAdmin, false);
  });

  it('sin token o con token inválido -> 401 en todas las rutas protegidas', async () => {
    const rutas = [
      ['GET', '/api/clientes'], ['POST', '/api/clientes'], ['GET', '/api/usuarios'], ['GET', '/api/roles'],
      ['GET', '/api/pagos/stats'], ['GET', '/api/dashboard/stats'], ['POST', '/api/upload/foto'],
      ['GET', '/api/auth/mis-permisos'],
    ];
    for (const [m, p] of rutas) {
      assert.equal((await api(m, p)).status, 401, `${m} ${p} sin token`);
      assert.equal((await api(m, p, { token: 'basura.token.x' })).status, 401, `${m} ${p} token inválido`);
    }
  });

  it('un usuario desactivado pierde acceso aunque su token siga vigente', async () => {
    const id = await dbUser({ nombre: 'Inactivo Prueba', email: testEmail('inactivo'), idRol: ctx.limitadoRolId });
    const { rows } = await pool.query('SELECT email FROM usuarios WHERE id = $1', [id]);
    const token = await login(rows[0].email);
    assert.equal((await api('GET', '/api/clientes', { token })).status, 200);
    await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [id]);
    assert.equal((await api('GET', '/api/clientes', { token })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: rows[0].email, password: PASSWORD } })).status, 401);
  });
});

describe('permisos denegados (403)', () => {
  it('rol con solo clientes_ver', async () => {
    const t = ctx.limitado;
    assert.equal((await api('GET', '/api/clientes', { token: t })).status, 200);
    assert.equal((await api('POST', '/api/clientes', { token: t, body: clienteBase() })).status, 403);
    assert.equal((await api('PUT', `/api/clientes/${crypto.randomUUID()}`, { token: t, body: {} })).status, 403);
    assert.equal((await api('DELETE', `/api/clientes/${crypto.randomUUID()}`, { token: t })).status, 403);
    assert.equal((await api('GET', '/api/pagos/stats', { token: t })).status, 403);
    assert.equal((await api('POST', '/api/pagos', { token: t, body: {} })).status, 403);
    assert.equal((await api('GET', '/api/roles', { token: t })).status, 403);
    assert.equal((await api('POST', '/api/roles', { token: t, body: {} })).status, 403);
    assert.equal((await api('GET', '/api/dashboard/stats', { token: t })).status, 403);
    assert.equal((await api('POST', '/api/upload/foto', { token: t })).status, 403);
  });

  it('gestión de usuarios exige Admin o Dueño', async () => {
    assert.equal((await api('GET', '/api/usuarios', { token: ctx.limitado })).status, 403);
    assert.equal((await api('POST', '/api/usuarios', { token: ctx.limitado, body: {} })).status, 403);
  });
});

describe('clientes', () => {
  it('alta inválida -> 400 con errors por campo', async () => {
    const r = await api('POST', '/api/clientes', { token: ctx.admin, body: {
      nombre: 'Juan3', apellido: '', dni: '123', telefono: '12ab', email: 'no-es-mail',
      fechaNacimiento: '2999-01-01', fechaVencimiento: '2020-13-45', estado: 'x',
    } });
    assertErrores(r, ['nombre', 'apellido', 'dni', 'telefono', 'email', 'fechaNacimiento', 'fechaVencimiento']);
  });

  it('cuerpo vacío -> 400 (no 500)', async () => {
    const r = await api('POST', '/api/clientes', { token: ctx.admin, raw: '', headers: {} });
    assertErrores(r, ['nombre', 'apellido', 'dni']);
  });

  it('vencimiento anterior al inicio -> 400', async () => {
    const r = await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({
      fechaInicioCuota: '2026-05-10', fechaVencimiento: '2026-05-01',
    }) });
    assertErrores(r, ['fechaVencimiento']);
  });

  it('largo y caracteres de nombre / dni / teléfono / email', async () => {
    const malos = [
      { nombre: 'A' }, { nombre: 'x'.repeat(51) }, { nombre: 'Ana_Maria' },
      { dni: '123456' }, { dni: '123456789' }, { dni: '12.345.678' },
      { telefono: '1234567' }, { telefono: '1'.repeat(16) }, { telefono: '++5491112345' },
      { email: `${'a'.repeat(95)}@x.com` },
    ];
    for (const m of malos) {
      const r = await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase(m) });
      assertErrores(r, [Object.keys(m)[0]]);
    }
  });

  let cli;
  it('alta válida normaliza datos y calcula vencimiento a 30 días', async () => {
    cli = await crearCliente({ nombre: "  María   José ", apellido: "O'Brien-Núñez", email: testEmail('MAYUS').toUpperCase(), telefono: '+5491112345678', fechaNacimiento: '1990-05-17' });
    assert.equal(cli.nombre, 'María José');
    assert.equal(cli.email, cli.email.toLowerCase());
    assert.equal(cli.fechaInicioCuota, hoyISO());
    assert.equal(cli.fechaVencimiento, addDays(hoyISO(), 30));
    assert.equal(cli.estadoCuota, 'al_dia');
    assert.equal(cli.nombreCompleto, "O'Brien-Núñez, María José");
  });

  it('DNI duplicado -> 409 con errors.dni', async () => {
    const r = await api('POST', '/api/clientes', { token: ctx.admin, body: clienteBase({ dni: cli.dni }) });
    assert.equal(r.status, 409, r.text);
    assert.ok(r.body.errors.dni);
  });

  it('get por id / id inválido / inexistente', async () => {
    const ok = await api('GET', `/api/clientes/${cli.id}`, { token: ctx.admin });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.dni, cli.dni);
    assert.equal((await api('GET', '/api/clientes/abc', { token: ctx.admin })).status, 400);
    assert.equal((await api('GET', `/api/clientes/${crypto.randomUUID()}`, { token: ctx.admin })).status, 404);
  });

  it('el listado incluye al cliente', async () => {
    const r = await api('GET', '/api/clientes', { token: ctx.limitado });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.some((c) => c.id === cli.id));
  });

  it('update parcial conserva los campos no enviados', async () => {
    const r = await api('PUT', `/api/clientes/${cli.id}`, { token: ctx.admin, body: { direccion: 'Calle Falsa 123' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.direccion, 'Calle Falsa 123');
    assert.equal(r.body.data.nombre, 'María José');
    assert.equal(r.body.data.telefono, '+5491112345678');
  });

  it('update puede vaciar un campo opcional con null', async () => {
    const r = await api('PUT', `/api/clientes/${cli.id}`, { token: ctx.admin, body: { telefono: null } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.telefono, null);
  });

  it('update inválido: estado, dni repetido, vencimiento anterior al inicio, nombre vacío', async () => {
    assertErrores(await api('PUT', `/api/clientes/${cli.id}`, { token: ctx.admin, body: { estado: 'zzz' } }), ['estado']);
    assertErrores(await api('PUT', `/api/clientes/${cli.id}`, { token: ctx.admin, body: { nombre: '' } }), ['nombre']);
    assertErrores(await api('PUT', `/api/clientes/${cli.id}`, { token: ctx.admin, body: { fechaVencimiento: '2000-01-01' } }), ['fechaVencimiento']);
    const otro = await crearCliente();
    const dup = await api('PUT', `/api/clientes/${otro.id}`, { token: ctx.admin, body: { dni: cli.dni } });
    assert.equal(dup.status, 409, dup.text);
    assert.ok(dup.body.errors.dni);
  });

  it('update de cliente inexistente -> 404', async () => {
    assert.equal((await api('PUT', `/api/clientes/${crypto.randomUUID()}`, { token: ctx.admin, body: { direccion: 'x' } })).status, 404);
  });

  it('estado_cuota usa un único umbral y coincide con el dashboard', async () => {
    const hoy = hoyISO();
    const moroso = await crearCliente({ fechaInicioCuota: addDays(hoy, -40), fechaVencimiento: addDays(hoy, -1) });
    const limite = await crearCliente({ fechaVencimiento: addDays(hoy, POR_VENCER_DIAS) });
    const lejos = await crearCliente({ fechaVencimiento: addDays(hoy, POR_VENCER_DIAS + 1) });
    assert.equal(moroso.estadoCuota, 'moroso');
    assert.equal(limite.estadoCuota, 'por_vencer');
    assert.equal(lejos.estadoCuota, 'al_dia');

    const lista = (await api('GET', '/api/clientes', { token: ctx.admin })).body.data;
    const porId = Object.fromEntries(lista.map((c) => [c.id, c.estadoCuota]));
    assert.equal(porId[limite.id], 'por_vencer');

    const stats = (await api('GET', '/api/dashboard/stats', { token: ctx.admin })).body.data;
    assert.equal(stats.porVencer, lista.filter((c) => c.estadoCuota === 'por_vencer').length);
    assert.equal(stats.morosos, lista.filter((c) => c.estadoCuota === 'moroso').length);
    // todo lo que lista "próximos vencimientos" tiene el mismo estado que en el listado de clientes
    for (const p of stats.proximosVencimientos) assert.equal(p.estadoCuota, porId[p.id]);
  });

  it('un cliente suspendido no tiene estado_cuota', async () => {
    const c = await crearCliente();
    const r = await api('PUT', `/api/clientes/${c.id}`, { token: ctx.admin, body: { estado: 'suspendido' } });
    assert.equal(r.body.data.estadoCuota, null);
  });

  it('delete: ok, luego 404', async () => {
    const c = await crearCliente();
    assert.equal((await api('DELETE', `/api/clientes/${c.id}`, { token: ctx.admin })).status, 200);
    assert.equal((await api('DELETE', `/api/clientes/${c.id}`, { token: ctx.admin })).status, 404);
    assert.equal((await api('DELETE', '/api/clientes/no-uuid', { token: ctx.admin })).status, 400);
  });
});

describe('pagos y cobros', () => {
  it('validaciones del cobro', async () => {
    const c = await crearCliente();
    const post = (body) => api('POST', '/api/pagos', { token: ctx.admin, body });
    assertErrores(await post({}), ['clienteId', 'monto', 'metodo']);
    assertErrores(await post({ clienteId: c.id, monto: -5, metodo: 'efectivo' }), ['monto']);
    assertErrores(await post({ clienteId: c.id, monto: 0, metodo: 'efectivo' }), ['monto']);
    assertErrores(await post({ clienteId: c.id, monto: 10.123, metodo: 'efectivo' }), ['monto']);
    assertErrores(await post({ clienteId: c.id, monto: 'abc', metodo: 'efectivo' }), ['monto']);
    assertErrores(await post({ clienteId: c.id, monto: 1e21, metodo: 'efectivo' }), ['monto']);
    assertErrores(await post({ clienteId: c.id, monto: 100, metodo: 'bitcoin' }), ['metodo']);
    assertErrores(await post({ clienteId: 'abc', monto: 100, metodo: 'efectivo' }), ['clienteId']);
    assert.equal((await post({ clienteId: crypto.randomUUID(), monto: 100, metodo: 'efectivo' })).status, 404);
  });

  it('cliente moroso: el período arranca hoy y dura 30 días', async () => {
    const hoy = hoyISO();
    const c = await crearCliente({ fechaInicioCuota: addDays(hoy, -40), fechaVencimiento: addDays(hoy, -5) });
    const r = await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 1500.5, metodo: 'transferencia' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(Number(r.body.data.monto), 1500.5);
    assert.equal(r.body.data.usuarioId, ctx.adminId);
    assert.equal(r.body.data.periodoDesde, hoy);
    assert.equal(r.body.data.periodoHasta, addDays(hoy, 30));
    assert.ok(r.body.data.periodoHasta >= r.body.data.periodoDesde);
    const cli = (await api('GET', `/api/clientes/${c.id}`, { token: ctx.admin })).body.data;
    assert.equal(cli.fechaVencimiento, addDays(hoy, 30));
    assert.equal(cli.estadoCuota, 'al_dia');
  });

  it('cliente al día: el período se encadena al vencimiento actual', async () => {
    const hoy = hoyISO();
    const c = await crearCliente({ fechaVencimiento: addDays(hoy, 10) });
    const r = await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: '2000', metodo: 'efectivo' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.data.periodoDesde, addDays(hoy, 10));
    assert.equal(r.body.data.periodoHasta, addDays(hoy, 40));
  });

  it('historial por cliente y stats de facturación', async () => {
    const c = await crearCliente();
    await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 100, metodo: 'transferencia' } });
    await api('POST', '/api/pagos', { token: ctx.admin, body: { clienteId: c.id, monto: 200, metodo: 'efectivo' } });
    const h = await api('GET', `/api/pagos/cliente/${c.id}`, { token: ctx.admin });
    assert.equal(h.status, 200);
    assert.equal(h.body.data.length, 2);
    assert.equal((await api('GET', '/api/pagos/cliente/abc', { token: ctx.admin })).status, 400);

    const s = await api('GET', '/api/pagos/stats', { token: ctx.admin });
    assert.equal(s.status, 200);
    for (const k of ['hoy', 'semana', 'mes']) assert.equal(typeof s.body.data[k], 'number');
    assert.ok(s.body.data.hoy >= 300 && s.body.data.mes >= s.body.data.hoy);
  });
});

describe('dashboard', () => {
  it('stats con la forma esperada', async () => {
    const r = await api('GET', '/api/dashboard/stats', { token: ctx.admin });
    assert.equal(r.status, 200, r.text);
    for (const k of ['total', 'activos', 'morosos', 'porVencer', 'nuevosMes']) {
      assert.equal(typeof r.body.data[k], 'number', k);
    }
    assert.ok(Array.isArray(r.body.data.proximosVencimientos));
  });

  it('un rol con estadisticas_ver puede verlo', async () => {
    const rolId = await dbRole(`Zztest${randLetters()}`, ['estadisticas_ver']);
    const email = testEmail('stats');
    await dbUser({ nombre: 'Stats Prueba', email, idRol: rolId });
    const t = await login(email);
    assert.equal((await api('GET', '/api/dashboard/stats', { token: t })).status, 200);
  });
});

describe('roles y permisos', () => {
  let rol;
  const nombreRol = `Zztest${randLetters()}`;

  it('listado y permisos disponibles', async () => {
    const l = await api('GET', '/api/roles', { token: ctx.admin });
    assert.equal(l.status, 200);
    assert.ok(l.body.data.every((r) => typeof r.userCount === 'number'));
    const p = await api('GET', '/api/roles/permisos', { token: ctx.admin });
    assert.ok(p.body.data.includes('clientes_ver'));
  });

  it('alta inválida -> 400', async () => {
    assertErrores(await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: 'Rol 123' } }), ['descripcion']);
    assertErrores(await api('POST', '/api/roles', { token: ctx.admin, body: {} }), ['descripcion']);
    assertErrores(await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: nombreRol, permissions: ['no_existe'] } }), ['permissions']);
    assertErrores(await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: nombreRol, permissions: 'clientes_ver' } }), ['permissions']);
  });

  it('alta válida con permisos y descripción duplicada -> 409', async () => {
    const r = await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: nombreRol, permissions: ['clientes_ver', 'clientes_ver', 'facturacion_ver'] } });
    assert.equal(r.status, 201, r.text);
    rol = r.body.data;
    ctx.ids.roles.push(rol.id);
    assert.deepEqual(rol.permissions, ['clientes_ver', 'facturacion_ver']);
    const dup = await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: nombreRol } });
    assert.equal(dup.status, 409, dup.text);
    assert.ok(dup.body.errors.descripcion);
  });

  it('update de permisos y de descripción', async () => {
    const r = await api('PUT', `/api/roles/${rol.id}`, { token: ctx.admin, body: { permissions: ['clientes_ver'] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.data.permissions, ['clientes_ver']);
    assert.equal(r.body.data.descripcion, nombreRol);
    assertErrores(await api('PUT', `/api/roles/${rol.id}`, { token: ctx.admin, body: { permissions: ['zzz'] } }), ['permissions']);
    // el rol no quedó vacío tras el intento fallido (la sincronización es atómica)
    const again = await api('GET', '/api/roles', { token: ctx.admin });
    assert.deepEqual(again.body.data.find((x) => x.id === rol.id).permissions, ['clientes_ver']);
  });

  it('el rol Admin no se puede modificar ni eliminar', async () => {
    assert.equal((await api('PUT', `/api/roles/${ctx.adminRolId}`, { token: ctx.admin, body: { descripcion: 'Otro' } })).status, 403);
    assert.equal((await api('DELETE', `/api/roles/${ctx.adminRolId}`, { token: ctx.admin })).status, 403);
  });

  it('no se elimina un rol con usuarios asignados (aunque estén inactivos)', async () => {
    await dbUser({ nombre: 'Inactivo Rol', email: testEmail('rolinact'), idRol: rol.id, activo: false });
    const r = await api('DELETE', `/api/roles/${rol.id}`, { token: ctx.admin });
    assert.equal(r.status, 409, r.text);
  });

  it('id inválido / inexistente', async () => {
    assert.equal((await api('PUT', '/api/roles/abc', { token: ctx.admin, body: {} })).status, 400);
    assert.equal((await api('DELETE', `/api/roles/${crypto.randomUUID()}`, { token: ctx.admin })).status, 404);
  });

  it('eliminar un rol sin usuarios', async () => {
    const c = await api('POST', '/api/roles', { token: ctx.admin, body: { descripcion: `Zztest${randLetters()}` } });
    assert.equal(c.status, 201, c.text);
    ctx.ids.roles.push(c.body.data.id);
    assert.equal((await api('DELETE', `/api/roles/${c.body.data.id}`, { token: ctx.admin })).status, 200);
  });
});

describe('usuarios', () => {
  let u;
  const email = testEmail('nuevo');

  it('listado con rol y flag protegido', async () => {
    const r = await api('GET', '/api/usuarios', { token: ctx.admin });
    assert.equal(r.status, 200);
    const yo = r.body.data.find((x) => x.id === ctx.adminId);
    assert.equal(yo.esAdmin, true);
    assert.equal(typeof yo.protegido, 'boolean');
    assert.equal(yo.rol, undefined);
    assert.ok(yo.rolDescripcion);
  });

  it('alta inválida -> 400 con errors por campo', async () => {
    const r = await api('POST', '/api/usuarios', { token: ctx.admin, body: { nombre: 'X', email: 'mal', password: 'corta', idRol: 'no-uuid' } });
    assertErrores(r, ['nombre', 'email', 'password', 'idRol']);
    assertErrores(await api('POST', '/api/usuarios', { token: ctx.admin, body: { nombre: 'Ana', email: testEmail('x'), password: 'soloLetrasAqui', idRol: ctx.limitadoRolId } }), ['password']);
    assertErrores(await api('POST', '/api/usuarios', { token: ctx.admin, body: { nombre: 'Ana', email: testEmail('x'), password: '123456789', idRol: ctx.limitadoRolId } }), ['password']);
    const rolInexistente = await api('POST', '/api/usuarios', { token: ctx.admin, body: { nombre: 'Ana', email: testEmail('x'), password: PASSWORD, idRol: crypto.randomUUID() } });
    assertErrores(rolInexistente, ['idRol']);
  });

  it('alta válida: email normalizado y login posible', async () => {
    const r = await api('POST', '/api/usuarios', { token: ctx.admin, body: { nombre: 'Usuario Nuevo', email: email.toUpperCase(), password: PASSWORD, idRol: ctx.limitadoRolId } });
    assert.equal(r.status, 201, r.text);
    u = r.body.data;
    ctx.ids.usuarios.push(u.id);
    assert.equal(u.email, email);
    assert.equal(u.idRol, ctx.limitadoRolId);
    assert.equal(u.passwordHash, undefined);
    await login(email);
  });

  it('email duplicado (sin importar mayúsculas) -> 409 con errors.email', async () => {
    const r = await api('POST', '/api/usuarios', { token: ctx.admin, body: { nombre: 'Otro Usuario', email: email.toUpperCase(), password: PASSWORD, idRol: ctx.limitadoRolId } });
    assert.equal(r.status, 409, r.text);
    assert.ok(r.body.errors.email);
  });

  it('update: válido, inválido, email repetido y usuario inexistente', async () => {
    const ok = await api('PUT', `/api/usuarios/${u.id}`, { token: ctx.admin, body: { nombre: 'Usuario Editado', email, idRol: ctx.sinPermisosRolId } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.data.nombre, 'Usuario Editado');
    assert.equal(ok.body.data.idRol, ctx.sinPermisosRolId);
    assertErrores(await api('PUT', `/api/usuarios/${u.id}`, { token: ctx.admin, body: { nombre: '', email: 'x', idRol: 'y' } }), ['nombre', 'email', 'idRol']);
    const dup = await api('PUT', `/api/usuarios/${u.id}`, { token: ctx.admin, body: { nombre: 'Usuario Editado', email: ctx.adminEmail, idRol: ctx.sinPermisosRolId } });
    assert.equal(dup.status, 409);
    assert.equal((await api('PUT', `/api/usuarios/${crypto.randomUUID()}`, { token: ctx.admin, body: { nombre: 'Ana', email: testEmail('x'), idRol: ctx.limitadoRolId } })).status, 404);
    assert.equal((await api('PUT', '/api/usuarios/abc', { token: ctx.admin, body: {} })).status, 400);
  });

  it('desactivar / reactivar; no se puede desactivar ni eliminar la propia cuenta', async () => {
    const off = await api('PATCH', `/api/usuarios/${u.id}/toggle-activo`, { token: ctx.admin });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.activo, false);
    assert.equal((await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status, 401);
    const on = await api('PATCH', `/api/usuarios/${u.id}/toggle-activo`, { token: ctx.admin });
    assert.equal(on.body.data.activo, true);
    assert.equal((await api('PATCH', `/api/usuarios/${ctx.adminId}/toggle-activo`, { token: ctx.admin })).status, 403);
    assert.equal((await api('DELETE', `/api/usuarios/${ctx.adminId}`, { token: ctx.admin })).status, 403);
    assert.equal((await api('PATCH', `/api/usuarios/${crypto.randomUUID()}/toggle-activo`, { token: ctx.admin })).status, 404);
  });

  it('un Dueño no puede crear ni tocar usuarios Admin', async (t) => {
    if (!ctx.dueno) return t.skip('no existe el rol Dueño');
    const crear = await api('POST', '/api/usuarios', { token: ctx.dueno, body: { nombre: 'Falso Admin', email: testEmail('esc'), password: PASSWORD, idRol: ctx.adminRolId } });
    assert.equal(crear.status, 403, crear.text);
    assert.equal((await api('PATCH', `/api/usuarios/${ctx.adminId}/toggle-activo`, { token: ctx.dueno })).status, 403);
    assert.equal((await api('DELETE', `/api/usuarios/${ctx.adminId}`, { token: ctx.dueno })).status, 403);
    const upd = await api('PUT', `/api/usuarios/${u.id}`, { token: ctx.dueno, body: { nombre: 'Usuario Editado', email, idRol: ctx.adminRolId } });
    assert.equal(upd.status, 403);
    // pero sí puede gestionar usuarios comunes
    const ok = await api('PUT', `/api/usuarios/${u.id}`, { token: ctx.dueno, body: { nombre: 'Editado Dueno', email, idRol: ctx.limitadoRolId } });
    assert.equal(ok.status, 200, ok.text);
  });

  it('superadmin protegido: visible pero PUT / PATCH / DELETE -> 403', { skip: external && 'requiere app en proceso' }, async () => {
    const lista = (await api('GET', '/api/usuarios', { token: ctx.admin })).body.data;
    const p = lista.find((x) => x.id === ctx.protegidoId);
    assert.equal(p.protegido, true);
    assert.equal(lista.filter((x) => x.protegido).length, 1);
    const put = await api('PUT', `/api/usuarios/${ctx.protegidoId}`, { token: ctx.admin, body: { nombre: 'Cambiado', email: testEmail('x'), idRol: ctx.limitadoRolId } });
    assert.equal(put.status, 403, put.text);
    assert.equal((await api('PATCH', `/api/usuarios/${ctx.protegidoId}/toggle-activo`, { token: ctx.admin })).status, 403);
    assert.equal((await api('DELETE', `/api/usuarios/${ctx.protegidoId}`, { token: ctx.admin })).status, 403);
    // otro usuario no puede quedarse con el email del protegido
    const dup = await api('PUT', `/api/usuarios/${u.id}`, { token: ctx.admin, body: { nombre: 'Usuario Editado', email: protectedEmail.toUpperCase(), idRol: ctx.limitadoRolId } });
    assert.equal(dup.status, 409);
    const { rows } = await pool.query('SELECT nombre, activo FROM usuarios WHERE id = $1', [ctx.protegidoId]);
    assert.deepEqual(rows[0], { nombre: 'Protegido Prueba', activo: true });
  });

  it('eliminar usuario: ok, 404 y 409 si tiene pagos', async () => {
    const del = await api('DELETE', `/api/usuarios/${u.id}`, { token: ctx.admin });
    assert.equal(del.status, 200, del.text);
    assert.equal((await api('DELETE', `/api/usuarios/${u.id}`, { token: ctx.admin })).status, 404);
    // el admin de prueba ya registró cobros en el bloque de pagos
    const { rows } = await pool.query('SELECT 1 FROM pagos WHERE usuario_id = $1 LIMIT 1', [ctx.adminId]);
    if (rows.length) {
      const otroAdmin = await dbUser({ nombre: 'Otro Admin', email: testEmail('otroadmin'), idRol: ctx.adminRolId });
      const t = await login((await pool.query('SELECT email FROM usuarios WHERE id = $1', [otroAdmin])).rows[0].email);
      const r = await api('DELETE', `/api/usuarios/${ctx.adminId}`, { token: t });
      assert.equal(r.status, 409, r.text);
    }
  });
});

describe('upload de fotos', () => {
  const form = (blob, name) => { const f = new FormData(); f.append('foto', blob, name); return f; };

  it('exige token', async () => {
    assert.equal((await api('POST', '/api/upload/foto')).status, 401);
  });

  it('sin archivo -> 400', async () => {
    const r = await api('POST', '/api/upload/foto', { token: ctx.admin });
    assert.equal(r.status, 400, r.text);
  });

  it('formato no permitido -> 400 (no se sube nada)', async () => {
    const f = form(new Blob(['no soy una imagen'], { type: 'text/plain' }), 'x.txt');
    const res = await fetch(`${baseUrl}/api/upload/foto`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.admin}` }, body: f });
    assert.equal(res.status, 400);
  });

  it('archivo de más de 5 MB -> 413', async () => {
    const f = form(new Blob([new Uint8Array(5 * 1024 * 1024 + 10)], { type: 'image/png' }), 'grande.png');
    const res = await fetch(`${baseUrl}/api/upload/foto`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.admin}` }, body: f });
    assert.equal(res.status, 413);
  });
});

// Helpers compartidos con scripts/extended-test.js (que importa este archivo y suma más describes).
module.exports = {
  api, login, dbUser, dbRole, crearCliente, crearProducto, assertErrores, ctx, rand, randLetters, randDni,
  testEmail, clienteBase, productoBase, PASSWORD, external, protectedEmail, getBaseUrl: () => baseUrl,
};
