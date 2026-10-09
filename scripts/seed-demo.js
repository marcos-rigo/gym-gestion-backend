// Seed de datos demo para ver todo el sistema funcionando con datos realistas.
//
// Uso:
//   node scripts/seed-demo.js --dry-run   → arma el plan y muestra el resumen, SIN conectarse a la base
//   node scripts/seed-demo.js             → inserta en la base configurada en .env (DATABASE_URL)
//   node scripts/seed-demo-cleanup.js     → borra todo lo generado por este seed
//
// Rango: los últimos 61 días hasta AYER (hoy no se toca, para no ensuciar la caja del día en curso).
// Las fechas son relativas a "hoy" en la zona del gimnasio, así los estados (moroso / por vencer / al día)
// quedan bien aunque se corra otro día.
//
// Marcas para poder deshacerlo (las usa seed-demo-cleanup.js):
//   - clientes: DNI en el rango reservado 980xxxxx (sus pagos y pago_metodos caen en cascada).
//   - ventas, movimientos_caja, movimientos_stock y productos creados: el timestamp (fecha_hora /
//     created_at) tiene los microsegundos fijos en .424242 (invisible en la UI).
//   - cierre_caja: detalle.seedDemo = true.
// No crea usuarios: usa los usuarios activos existentes. No crea caja_apertura.

require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { TZ, POR_VENCER_DIAS, PERIODO_DIAS, HORA_CORTE_TURNO, hoyISO, addDays } = require('../src/config/fechas');

const DNI_PREFIJO = '980';
const MARCA_US = 424242;
const DIAS_RANGO = 61;
// Los cierres se generan hasta hoy - 3: ayer y anteayer quedan abiertos para poder probar el cierre.
const CIERRES_HASTA_OFF = -3;

// SQL para reconocer registros del seed (los usa también el cleanup).
const ES_DNI_DEMO = `(dni LIKE '${DNI_PREFIJO}_____')`;
const esDemoTs = (col) => `(EXTRACT(MICROSECONDS FROM ${col})::bigint % 1000000 = ${MARCA_US})`;
const ES_CIERRE_DEMO = `(detalle->>'seedDemo' = 'true')`;

// ---------- utilidades ----------

// PRNG con semilla fija: el plan (cantidades, horarios, métodos) es el mismo en cada corrida.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260809);
const randInt = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const weighted = (pairs) => {
  let r = rnd() * pairs.reduce((acc, [, w]) => acc + w, 0);
  for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
};
const pad = (n) => String(n).padStart(2, '0');
const round = (n, step) => Math.round(n / step) * step;

// Timestamp local del gimnasio con la marca en los microsegundos. Se inserta como
// `($n::timestamp AT TIME ZONE TZ)`, así Postgres hace la conversión a UTC.
class Ts {
  constructor(fecha, minutos) {
    this.fecha = fecha;
    this.minutos = minutos;
    this.hora = Math.floor(minutos / 60);
    this.local = `${fecha} ${pad(this.hora)}:${pad(minutos % 60)}:${pad((minutos * 7) % 60)}.${MARCA_US}`;
  }
  plus(min) { return new Ts(this.fecha, this.minutos + min); }
  get turno() { return this.hora < HORA_CORTE_TURNO ? 'mañana' : 'tarde'; }
}

// Horarios de cada turno (ajustados a HORA_CORTE_TURNO).
const CORTE = Math.min(Math.max(HORA_CORTE_TURNO, 9), 21);
const horaManana = () => randInt(7, CORTE - 1);
const horaTarde = () => randInt(CORTE, 21);
const tsEnTurno = (fecha, turno) => new Ts(fecha, (turno === 'mañana' ? horaManana() : horaTarde()) * 60 + randInt(0, 59));

const diaSemana = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = domingo

// ---------- datos base ----------

// Cuota mensual por plan; el mes anterior al anterior (agosto si hoy es octubre) tenía precio viejo.
const PRECIOS_CUOTA = { libre: { viejo: 35000, actual: 38000 }, '3x': { viejo: 28000, actual: 30000 } };

const PRODUCTOS = [
  { key: 'aguaChica', nombre: 'Agua chica', descripcion: 'Agua mineral sin gas 500 ml', precio: 1200, stockFinal: 34, stockMinimo: 12, peso: 50 },
  { key: 'aguaGrande', nombre: 'Agua grande', descripcion: 'Agua mineral sin gas 1,5 L', precio: 2000, stockFinal: 18, stockMinimo: 8, peso: 25 },
  { key: 'gatorade', nombre: 'Gatorade', descripcion: 'Bebida isotónica 500 ml', precio: 2800, stockFinal: 21, stockMinimo: 10, peso: 25 },
];
// Reposiciones (ajuste de stock) asociadas a los egresos a proveedores.
const REPOSICIONES = [
  { d: -45, min: 10 * 60 + 25, items: { aguaChica: 48, aguaGrande: 24 } },
  { d: -12, min: 10 * 60 + 45, items: { gatorade: 36 } },
];

// Clientes. `alta` y `venc0` son offsets en días respecto de hoy. `venc0` es el vencimiento que tenía
// el cliente al empezar el rango (los que se dieron de alta dentro del rango arrancan con venc0 = alta).
// Cada pago: { d, metodo?, h?: [hora, min], anular?: motivo, plan?: plan cobrado si difiere }.
// La cuota se simula igual que pago.create: desde = max(vencimiento actual, fecha del pago), +30 días.
const CLIENTES = [
  // --- al día ---
  { nombre: 'Lucía', apellido: 'Fernández', nac: '1994-03-12', plan: 'libre', alta: -420, venc0: -45,
    pagos: [{ d: -46 }, { d: -16 }], obs: null },
  { nombre: 'Martín', apellido: 'González', nac: '1988-11-02', plan: '3x', alta: -40,
    pagos: [{ d: -40 }, { d: -10, metodo: 'transferencia' }], obs: null },
  { nombre: 'Sofía', apellido: 'Rodríguez', nac: '1979-06-25', plan: 'libre', alta: -300, venc0: -35,
    pagos: [{ d: -37, metodo: 'efectivo' }, { d: -5, metodo: 'mixto' }],
    obs: 'Hipertensa controlada. Evitar cargas máximas sin supervisión.' },
  { nombre: 'Juan Pablo', apellido: 'Gómez', nac: '2001-01-17', plan: 'libre', alta: -150, venc0: -50,
    pagos: [{ d: -48 }, { d: -19 }], obs: null },
  { nombre: 'Valentina', apellido: 'López', nac: '1997-09-08', plan: '3x', alta: -210, venc0: -38,
    pagos: [
      { d: -39 },
      { d: -6, h: [10, 5], plan: 'libre', anular: 'Se cobró el plan equivocado (pase libre en vez de 3 veces por semana)' },
      { d: -6, h: [10, 30] },
    ], obs: null },
  // --- por vencer (próximos POR_VENCER_DIAS días) ---
  { nombre: 'Camila', apellido: 'Martínez', nac: '1992-04-30', plan: 'libre', alta: -500, venc0: -56,
    pagos: [{ d: -57 }, { d: -27 }], obs: null },
  { nombre: 'Nicolás', apellido: 'Pérez', nac: '1985-12-14', plan: '3x', alta: -95, venc0: -58,
    pagos: [{ d: -58 }, { d: -27, metodo: 'mixto' }], obs: null },
  { nombre: 'Agustina', apellido: 'Sánchez', nac: '1999-07-21', plan: 'libre', alta: -260, venc0: -53,
    pagos: [{ d: -53 }, { d: -24 }], obs: 'Prefiere que le avisen el vencimiento por WhatsApp.' },
  { nombre: 'Tomás', apellido: 'Romero', nac: '2004-02-03', plan: 'libre', alta: -120, venc0: -60,
    pagos: [{ d: -60 }, { d: -31, metodo: 'transferencia' }], obs: null },
  // --- morosos ---
  { nombre: 'Florencia', apellido: 'Sosa', nac: '1990-10-19', plan: 'libre', alta: -380, venc0: -52,
    pagos: [{ d: -52 }, { d: -22, h: [18, 40], anular: 'Error de carga: el cobro correspondía a otro cliente' }],
    obs: null },
  { nombre: 'Matías', apellido: 'Álvarez', nac: '1983-05-06', plan: '3x', alta: -700, venc0: -40,
    pagos: [{ d: -41 }], obs: 'Trabaja por turnos rotativos, a veces deja de venir un tiempo.' },
  { nombre: 'Julieta', apellido: 'Torres', nac: '1996-08-27', plan: 'libre', alta: -180, venc0: -61,
    pagos: [{ d: -60, metodo: 'efectivo' }], obs: null },
  { nombre: 'Gonzalo', apellido: 'Ruiz', nac: '1975-03-09', plan: 'libre', alta: -33,
    pagos: [{ d: -33 }], obs: 'Dijo que paga a fin de mes.' },
  // --- nuevos (alta este mes) ---
  { nombre: 'Milagros', apellido: 'Acosta', nac: '2006-12-01', plan: 'libre', alta: -7, nuevo: true,
    pagos: [{ d: -7 }], obs: 'Viene recomendada por Lucía Fernández.' },
  { nombre: 'Franco', apellido: 'Medina', nac: '1993-02-22', plan: '3x', alta: -4, nuevo: true,
    pagos: [{ d: -4, metodo: 'transferencia' }], obs: null },
  { nombre: 'Micaela', apellido: 'Herrera', nac: '1987-07-13', plan: 'libre', alta: -2, nuevo: true,
    pagos: [{ d: -2, metodo: 'mixto' }], obs: 'Lesión previa en hombro derecho; consultar antes de press militar.' },
  { nombre: 'Bruno', apellido: 'Aguirre', nac: '2002-10-05', plan: 'libre', alta: -1, nuevo: true,
    pagos: [{ d: -1, metodo: 'efectivo' }], obs: null },
  // --- inactivos ---
  { nombre: 'Carolina', apellido: 'Molina', nac: '1981-01-28', plan: 'libre', alta: -620, venc0: -50, estado: 'suspendido',
    pagos: [{ d: -50 }], obs: 'Suspendida temporalmente por lesión de rodilla (vuelve en noviembre).' },
  { nombre: 'Diego', apellido: 'Castro', nac: '1978-09-16', plan: '3x', alta: -340, venc0: -44, estado: 'suspendido',
    pagos: [], obs: 'Se mudó a Yerba Buena, pidió la baja.' },
  { nombre: 'Paula', apellido: 'Ríos', nac: '1998-05-04', plan: 'libre', alta: -230, venc0: -47, estado: 'vencido',
    pagos: [{ d: -47, metodo: 'transferencia' }], obs: null },
];

const CALLES = [
  'Av. Mate de Luna', 'San Martín', '24 de Septiembre', 'Av. Sarmiento', 'Laprida', 'Muñecas',
  'Av. Aconquija', 'Córdoba', 'Santiago del Estero', 'Crisóstomo Álvarez', 'Av. Belgrano', 'Marcos Paz',
];
const VINCULOS = ['madre', 'padre', 'pareja', 'hermana', 'hermano', 'hija'];
const NOMBRES_CONTACTO = ['Marta', 'Jorge', 'Silvia', 'Raúl', 'Graciela', 'Carlos', 'Andrea', 'Pablo'];

// Movimientos de caja: { d, min, tipo, concepto, monto, metodo, anular? }
const MOVIMIENTOS = [
  { d: -58, min: 9 * 60 + 30, tipo: 'egreso', concepto: 'Compra de insumos de limpieza', monto: 18500, metodo: 'efectivo' },
  { d: -52, min: 16 * 60 + 10, tipo: 'ingreso_extra', concepto: 'Pase diario (clase de prueba)', monto: 5000, metodo: 'efectivo' },
  { d: -45, min: 10 * 60 + 20, tipo: 'egreso', concepto: 'Pago proveedor de agua', monto: 64800, metodo: 'transferencia' },
  { d: -40, min: 18 * 60 + 45, tipo: 'ingreso_extra', concepto: 'Alquiler de sala para clase de yoga', monto: 25000, metodo: 'efectivo' },
  { d: -33, min: 11 * 60 + 5, tipo: 'egreso', concepto: 'Reparación de cinta de correr', monto: 45000, metodo: 'transferencia' },
  { d: -27, min: 17 * 60 + 30, tipo: 'egreso', concepto: 'Bolsas de residuos y papel higiénico', monto: 7800, metodo: 'efectivo' },
  { d: -27, min: 17 * 60 + 41, tipo: 'egreso', concepto: 'Bolsas de residuos y papel higiénico', monto: 7800, metodo: 'efectivo',
    anular: 'Cargado dos veces' },
  { d: -20, min: 9 * 60 + 15, tipo: 'egreso', concepto: 'Compra de insumos de limpieza', monto: 21300, metodo: 'efectivo' },
  { d: -14, min: 19 * 60 + 20, tipo: 'ingreso_extra', concepto: 'Pase diario (clase de prueba)', monto: 5000, metodo: 'efectivo' },
  { d: -12, min: 10 * 60 + 40, tipo: 'egreso', concepto: 'Pago proveedor de Gatorade', monto: 58000, metodo: 'transferencia' },
  { d: -8, min: 20 * 60 + 5, tipo: 'ingreso_extra', concepto: 'Alquiler de espacio a personal trainer externo', monto: 40000, metodo: 'transferencia' },
  { d: -5, min: 12 * 60 + 30, tipo: 'egreso', concepto: 'Cambio de cerradura de vestuario', monto: 15000, metodo: 'efectivo' },
  { d: -3, min: 16 * 60 + 50, tipo: 'egreso', concepto: 'Recarga de bidones para dispenser', monto: 9600, metodo: 'efectivo' },
  { d: -2, min: 8 * 60 + 45, tipo: 'ingreso_extra', concepto: 'Pase diario (clase de prueba)', monto: 5000, metodo: 'efectivo' },
];

const MOTIVOS_ANULACION_VENTA = [
  'Se registró por error, el cliente no se llevó el producto',
  'Producto devuelto: botella abollada',
];

// ---------- plan (independiente de la base) ----------

// Arma todo lo que se va a crear. Los usuarios se referencian por rol ('manana' | 'tarde' | 'extra' |
// 'admin') y los productos por key; se resuelven contra la base recién al insertar.
function buildPlan(hoy) {
  const desde = addDays(hoy, -DIAS_RANGO);
  const [y, m, d] = hoy.split('-').map(Number);
  const mesOff = -(d - 1); // offset del día 1 del mes actual
  const inicioMesAnterior = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const precioCuota = (plan, fecha) => PRECIOS_CUOTA[plan][fecha < inicioMesAnterior ? 'viejo' : 'actual'];
  const usuarioDeTurno = (ts) => (rnd() < 0.15 ? 'extra' : ts.turno === 'mañana' ? 'manana' : 'tarde');

  const dnis = new Set();
  const nuevoDni = () => {
    let dni;
    do dni = `${DNI_PREFIJO}${String(randInt(0, 99999)).padStart(5, '0')}`; while (dnis.has(dni));
    dnis.add(dni);
    return dni;
  };
  const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '');

  const clientes = [];
  const pagos = [];

  for (const spec of CLIENTES) {
    let { alta } = spec;
    let pagosSpec = spec.pagos;
    // "Nuevos" tienen que caer en el mes actual (y nunca hoy).
    if (spec.nuevo) {
      let off = Math.max(alta, mesOff);
      if (off >= 0) off = -1;
      pagosSpec = pagosSpec.map((p) => ({ ...p, d: off }));
      alta = off;
    }
    const fechaAlta = addDays(hoy, alta);
    let venc = addDays(hoy, spec.venc0 ?? alta);
    let inicio = spec.venc0 != null ? addDays(venc, -PERIODO_DIAS) : fechaAlta;

    const id = crypto.randomUUID();
    let ultimoTs = null;
    let primerTs = null;
    for (const p of pagosSpec) {
      const fecha = addDays(hoy, p.d);
      let ts;
      if (p.h) ts = new Ts(fecha, p.h[0] * 60 + p.h[1]);
      else if (ultimoTs?.fecha === fecha) ts = ultimoTs.plus(randInt(20, 40));
      else ts = tsEnTurno(fecha, rnd() < 0.5 ? 'mañana' : 'tarde');
      ultimoTs = ts;
      primerTs ??= ts;

      const periodoDesde = fecha > venc ? fecha : venc;
      const periodoHasta = addDays(periodoDesde, PERIODO_DIAS);
      const monto = precioCuota(p.plan ?? spec.plan, fecha);
      const metodo = p.metodo ?? weighted([['efectivo', 50], ['transferencia', 35], ['mixto', 15]]);
      const desglose = metodo === 'mixto'
        ? (() => { const ef = round(monto * (0.3 + rnd() * 0.4), 1000); return [['efectivo', ef], ['transferencia', monto - ef]]; })()
        : [[metodo, monto]];

      pagos.push({
        id: crypto.randomUUID(), clienteId: id, usuario: usuarioDeTurno(ts), monto, metodo, desglose,
        periodoDesde, periodoHasta, ts,
        anulado: p.anular ? { motivo: p.anular, ts: ts.plus(randInt(8, 20)) } : null,
      });
      // Un pago anulado no renueva la cuota (pago.anular revierte al período del pago vigente anterior).
      if (!p.anular) { inicio = periodoDesde; venc = periodoHasta; }
    }

    const estado = spec.estado ?? 'activo';
    const nn = randInt(1, 99);
    clientes.push({
      id, nombre: spec.nombre, apellido: spec.apellido, dni: nuevoDni(), nac: spec.nac,
      telefono: rnd() < 0.9 ? `381${pick(['4', '5', '6'])}${String(randInt(0, 999999)).padStart(6, '0')}` : null,
      email: rnd() < 0.75 ? `${slug(spec.nombre)}.${slug(spec.apellido)}${nn}@example.com` : null,
      direccion: rnd() < 0.7 ? `${pick(CALLES)} ${randInt(1, 45) * 50 + randInt(0, 49)}` : null,
      contactoEmergencia: rnd() < 0.5 ? `${pick(NOMBRES_CONTACTO)} (${pick(VINCULOS)}) 381${randInt(4000000, 6999999)}` : null,
      observaciones: spec.obs,
      fechaAlta, inicio, venc, estado,
      // created_at define "nuevos del mes" en el dashboard: el alta de los nuevos queda unos minutos antes del cobro.
      createdTs: primerTs && spec.venc0 == null ? new Ts(fechaAlta, Math.max(primerTs.minutos - randInt(3, 10), 0)) : new Ts(fechaAlta, 10 * 60 + randInt(0, 59)),
      estadoCuota: estado !== 'activo' ? null
        : venc < hoy ? 'moroso'
        : venc <= addDays(hoy, POR_VENCER_DIAS) ? 'por_vencer' : 'al_dia',
      nuevoMes: fechaAlta >= addDays(hoy, mesOff),
    });
  }

  // Ventas: más movimiento a medida que avanza el período (primavera), menos los domingos.
  const ventas = [];
  for (let off = -DIAS_RANGO; off <= -1; off++) {
    const fecha = addDays(hoy, off);
    const t = (off + DIAS_RANGO) / DIAS_RANGO;
    let esperado = 1.5 + 2.5 * t;
    if (diaSemana(fecha) === 0) esperado *= 0.3;
    if (diaSemana(fecha) === 6) esperado *= 0.7;
    const n = Math.max(0, Math.floor(esperado + rnd() * 2 - 0.5));
    for (let i = 0; i < n; i++) {
      const ts = tsEnTurno(fecha, rnd() < 0.45 ? 'mañana' : 'tarde');
      const cantProductos = rnd() < 0.05 ? 3 : rnd() < 0.25 ? 2 : 1;
      const keys = [];
      while (keys.length < cantProductos) {
        const k = weighted(PRODUCTOS.map((p) => [p.key, p.peso]));
        if (!keys.includes(k)) keys.push(k);
      }
      const items = keys.map((key) => ({ key, cantidad: weighted([[1, 70], [2, 22], [3, 4], [4, 2], [6, 2]]) }));
      const activos = clientes.filter((c) => c.fechaAlta <= fecha && c.estado === 'activo');
      ventas.push({
        id: crypto.randomUUID(), ts, items, usuario: usuarioDeTurno(ts),
        clienteId: rnd() < 0.35 && activos.length ? pick(activos).id : null,
        pago: { tipo: weighted([['efectivo', 55], ['transferencia', 35], ['mixto', 10]]), fraccion: 0.3 + rnd() * 0.4 },
        anulada: null,
      });
    }
  }
  ventas.sort((a, b) => a.ts.local.localeCompare(b.ts.local));
  // Dos ventas anuladas, una en cada mitad del período.
  [Math.floor(ventas.length * 0.3), Math.floor(ventas.length * 0.8)].forEach((idx, i) => {
    ventas[idx].anulada = { motivo: MOTIVOS_ANULACION_VENTA[i], ts: ventas[idx].ts.plus(randInt(3, 15)) };
  });

  const movimientos = MOVIMIENTOS.map((mv) => {
    const ts = new Ts(addDays(hoy, mv.d), mv.min);
    return {
      id: crypto.randomUUID(), ...mv, ts, usuario: ts.turno === 'mañana' ? 'manana' : 'tarde',
      anulado: mv.anular ? { motivo: mv.anular, ts: ts.plus(5) } : null,
    };
  });

  // Turnos con actividad vigente que se cierran (hasta hoy + CIERRES_HASTA_OFF).
  const limiteCierres = addDays(hoy, CIERRES_HASTA_OFF);
  const turnos = new Map();
  const marcar = (ts, usuario) => {
    if (ts.fecha > limiteCierres) return;
    const k = `${ts.fecha}|${ts.turno}`;
    if (!turnos.has(k)) turnos.set(k, { fecha: ts.fecha, turno: ts.turno, usuario });
  };
  pagos.filter((p) => !p.anulado).forEach((p) => marcar(p.ts, p.usuario));
  ventas.filter((v) => !v.anulada).forEach((v) => marcar(v.ts, v.usuario));
  movimientos.filter((mv) => !mv.anulado).forEach((mv) => marcar(mv.ts, mv.usuario));
  const cierres = [...turnos.values()].sort((a, b) => (a.fecha + a.turno).localeCompare(b.fecha + b.turno));

  return { hoy, desde, hasta: addDays(hoy, -1), inicioMesAnterior, clientes, pagos, ventas, movimientos, cierres };
}

// ---------- materialización (plan → filas por tabla) ----------

// ctx.usuarios: { manana, tarde, extra, admin } → id. ctx.productos: key → { id, nombre, precio, creado }.
function materializar(plan, ctx) {
  const u = (rol) => ctx.usuarios[rol];
  const rows = {
    productos: [], clientes: [], pagos: [], pago_metodos: [], ventas: [], venta_items: [],
    venta_pagos: [], movimientos_stock: [], movimientos_caja: [],
  };

  for (const c of plan.clientes) {
    rows.clientes.push({
      id: c.id, nombre: c.nombre, apellido: c.apellido, dni: c.dni, fecha_nacimiento: c.nac,
      telefono: c.telefono, email: c.email, direccion: c.direccion, contacto_emergencia: c.contactoEmergencia,
      observaciones: c.observaciones, fecha_alta: c.fechaAlta, fecha_inicio_cuota: c.inicio,
      fecha_vencimiento: c.venc, estado: c.estado, created_at: c.createdTs, updated_at: c.createdTs,
    });
  }

  for (const p of plan.pagos) {
    rows.pagos.push({
      id: p.id, cliente_id: p.clienteId, usuario_id: u(p.usuario), monto: p.monto, metodo: p.metodo,
      periodo_desde: p.periodoDesde, periodo_hasta: p.periodoHasta, fecha_pago: p.ts,
      anulado: !!p.anulado, anulado_at: p.anulado?.ts ?? null, anulado_por: p.anulado ? u('admin') : null,
      motivo_anulacion: p.anulado?.motivo ?? null,
    });
    for (const [metodo, monto] of p.desglose) {
      rows.pago_metodos.push({ id: crypto.randomUUID(), id_pago: p.id, metodo, monto });
    }
  }

  // Precio histórico: antes del mes anterior los productos salían ~10% menos.
  const precioEn = (prod, fecha) => (fecha < plan.inicioMesAnterior ? round(prod.precio * 0.9, 100) : prod.precio);
  const vendidos = {}; // key → eventos de stock [{ local, delta }]
  for (const v of plan.ventas) {
    let total = 0;
    for (const it of v.items) {
      const prod = ctx.productos[it.key];
      const precio = precioEn(prod, v.ts.fecha);
      const subtotal = Math.round(precio * it.cantidad * 100) / 100;
      total += subtotal;
      rows.venta_items.push({
        id: crypto.randomUUID(), id_venta: v.id, id_producto: prod.id, nombre_snapshot: prod.nombre,
        precio_unitario: precio, cantidad: it.cantidad, subtotal,
      });
      if (prod.creado) {
        (vendidos[it.key] ??= []).push({ ts: v.ts, delta: -it.cantidad, tipo: 'venta', idVenta: v.id, usuario: v.usuario });
        if (v.anulada) {
          vendidos[it.key].push({ ts: v.anulada.ts, delta: it.cantidad, tipo: 'anulacion_venta', idVenta: v.id, usuario: 'admin' });
        }
      }
    }
    total = Math.round(total * 100) / 100;
    let tipo = v.pago.tipo;
    if (tipo === 'mixto' && total < 2000) tipo = 'efectivo';
    const pagosVenta = tipo === 'mixto'
      ? (() => { const ef = Math.min(Math.max(round(total * v.pago.fraccion, 500), 500), total - 500); return [['efectivo', ef], ['transferencia', total - ef]]; })()
      : [[tipo, total]];
    for (const [metodo, monto] of pagosVenta) {
      rows.venta_pagos.push({ id: crypto.randomUUID(), id_venta: v.id, metodo, monto });
    }
    rows.ventas.push({
      id: v.id, fecha_hora: v.ts, created_at: v.ts, id_usuario: u(v.usuario), id_cliente: v.clienteId, total,
      anulada: !!v.anulada, motivo_anulacion: v.anulada?.motivo ?? null,
      anulada_por: v.anulada ? u('admin') : null, anulada_at: v.anulada?.ts ?? null,
    });
    v.metodoResumen = pagosVenta.length > 1 ? 'mixto' : pagosVenta[0][0];
  }

  // Stock solo para los productos que crea el seed: stock inicial (ajuste) + reposiciones + ventas,
  // de modo que el stock_actual final sea consistente con movimientos_stock. A los existentes no se les toca el stock.
  for (const spec of PRODUCTOS) {
    const prod = ctx.productos[spec.key];
    if (!prod.creado) continue;
    const eventos = [...(vendidos[spec.key] ?? [])];
    for (const r of REPOSICIONES) {
      if (r.items[spec.key]) {
        eventos.push({ ts: new Ts(addDays(plan.hoy, r.d), r.min), delta: r.items[spec.key], tipo: 'ajuste', usuario: 'admin' });
      }
    }
    eventos.sort((a, b) => a.ts.local.localeCompare(b.ts.local));
    const neto = eventos.reduce((acc, e) => acc + e.delta, 0);
    let inicial = spec.stockFinal - neto;
    let corriente = inicial;
    let minimo = inicial;
    for (const e of eventos) { corriente += e.delta; minimo = Math.min(minimo, corriente); }
    if (minimo < 0) inicial -= minimo; // nunca stock negativo
    const altaTs = new Ts(plan.desde, 7 * 60);
    eventos.unshift({ ts: altaTs.plus(10), delta: inicial, tipo: 'ajuste', usuario: 'admin' });

    rows.productos.push({
      id: prod.id, nombre: spec.nombre, descripcion: spec.descripcion, categoria: 'Bebidas', precio: spec.precio,
      activo: true, controla_stock: true, stock_actual: inicial + neto, stock_minimo: spec.stockMinimo,
      created_at: altaTs, updated_at: altaTs,
    });
    for (const e of eventos) {
      rows.movimientos_stock.push({
        id: crypto.randomUUID(), id_producto: prod.id, tipo: e.tipo, cantidad: e.delta,
        id_venta: e.idVenta ?? null, id_usuario: u(e.usuario), fecha_hora: e.ts,
      });
    }
  }

  for (const mv of plan.movimientos) {
    rows.movimientos_caja.push({
      id: mv.id, tipo: mv.tipo, concepto: mv.concepto, monto: mv.monto, metodo: mv.metodo, fecha_hora: mv.ts,
      id_usuario: u(mv.usuario), anulado: !!mv.anulado, motivo_anulacion: mv.anulado?.motivo ?? null,
      anulado_por: mv.anulado ? u('admin') : null, anulado_at: mv.anulado?.ts ?? null,
    });
  }
  return rows;
}

// ---------- resumen ----------

const contar = (arr, fn) => arr.reduce((acc, x) => { const k = fn(x); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const fmt = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ');
const pesos = (n) => `$${Math.round(n).toLocaleString('es-AR')}`;

function imprimirResumen(plan, rows, { cierres, productosExistentes = [] }) {
  const L = (s = '') => console.log(s);
  const turnoDe = (ts) => ts.turno;
  L(`\nRango: ${plan.desde} → ${plan.hasta} (hoy ${plan.hoy} no se toca) · zona ${TZ} · corte de turno ${HORA_CORTE_TURNO}hs`);
  L('');
  L('Tabla                 Filas  Detalle');
  L('--------------------  -----  -------');
  const row = (t, n, det = '') => L(`${t.padEnd(20)}  ${String(n).padStart(5)}  ${det}`);

  row('clientes', rows.clientes.length,
    `estado → ${fmt(contar(plan.clientes, (c) => c.estado))}`);
  L(`${''.padEnd(29)}cuota → ${fmt(contar(plan.clientes.filter((c) => c.estadoCuota), (c) => c.estadoCuota))}`);
  L(`${''.padEnd(29)}nuevos este mes: ${plan.clientes.filter((c) => c.nuevoMes).length}, con observaciones: ${plan.clientes.filter((c) => c.observaciones).length}`);
  const pagosVig = plan.pagos.filter((p) => !p.anulado);
  row('pagos', rows.pagos.length,
    `${fmt(contar(plan.pagos, (p) => p.metodo))} · turno → ${fmt(contar(plan.pagos, (p) => turnoDe(p.ts)))} · anulados: ${plan.pagos.length - pagosVig.length}`);
  L(`${''.padEnd(29)}cobrado vigente: ${pesos(pagosVig.reduce((a, p) => a + p.monto, 0))}`);
  row('pago_metodos', rows.pago_metodos.length);
  row('productos', rows.productos.length, [
    rows.productos.length ? `nuevos: ${rows.productos.map((p) => `${p.nombre} ${pesos(p.precio)} (stock final ${p.stock_actual})`).join(', ')}` : '',
    productosExistentes.length ? `ya existían, se reutilizan sin tocar stock: ${productosExistentes.join(', ')}` : '',
  ].filter(Boolean).join(' · '));
  const ventasVig = rows.ventas.filter((v) => !v.anulada);
  row('ventas', rows.ventas.length,
    `${fmt(contar(plan.ventas, (v) => v.metodoResumen))} · turno → ${fmt(contar(plan.ventas, (v) => turnoDe(v.ts)))} · anuladas: ${rows.ventas.length - ventasVig.length}`);
  const unidades = {};
  const anuladas = new Set(rows.ventas.filter((v) => v.anulada).map((v) => v.id));
  for (const it of rows.venta_items) if (!anuladas.has(it.id_venta)) unidades[it.nombre_snapshot] = (unidades[it.nombre_snapshot] ?? 0) + it.cantidad;
  L(`${''.padEnd(29)}vendido vigente: ${pesos(ventasVig.reduce((a, v) => a + v.total, 0))} · unidades → ${fmt(unidades)}`);
  L(`${''.padEnd(29)}con cliente asociado: ${rows.ventas.filter((v) => v.id_cliente).length}`);
  row('venta_items', rows.venta_items.length);
  row('venta_pagos', rows.venta_pagos.length);
  row('movimientos_stock', rows.movimientos_stock.length, rows.movimientos_stock.length ? fmt(contar(rows.movimientos_stock, (m) => m.tipo)) : '(no se crean productos → no se toca stock)');
  row('movimientos_caja', rows.movimientos_caja.length,
    `${fmt(contar(rows.movimientos_caja, (m) => m.tipo))} · turno → ${fmt(contar(plan.movimientos, (m) => turnoDe(m.ts)))} · anulados: ${rows.movimientos_caja.filter((m) => m.anulado).length}`);
  row('cierre_caja', cierres.length,
    `turnos con actividad hasta ${addDays(plan.hoy, CIERRES_HASTA_OFF)} · ${fmt(contar(cierres, (c) => c.turno))}`);
  L('\nSin cambios en: usuarios, roles, caja_apertura.');
}

// ---------- inserción ----------

async function insertMany(client, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const chunk = Math.floor(20000 / cols.length);
  for (let i = 0; i < rows.length; i += chunk) {
    const params = [];
    const tuples = rows.slice(i, i + chunk).map((r) => `(${cols.map((c) => {
      const v = r[c];
      params.push(v instanceof Ts ? v.local : v);
      return v instanceof Ts ? `($${params.length}::timestamp AT TIME ZONE '${TZ}')` : `$${params.length}`;
    }).join(', ')})`);
    await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const plan = buildPlan(hoyISO());

  if (dryRun) {
    const ctx = {
      usuarios: { manana: 'usuario-turno-mañana', tarde: 'usuario-turno-tarde', extra: 'usuario-extra', admin: 'admin' },
      productos: Object.fromEntries(PRODUCTOS.map((p) => [p.key, { id: `producto-${p.key}`, nombre: p.nombre, precio: p.precio, creado: true }])),
    };
    const rows = materializar(plan, ctx);
    console.log('DRY RUN: no se conecta a la base. Cantidades asumiendo que los 3 productos no existen y que ningún turno ya está cerrado.');
    imprimirResumen(plan, rows, { cierres: plan.cierres });
    return;
  }

  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL en .env');
  const { pool, withTransaction } = require('../src/config/db');
  const { getTotalesTurno } = require('../src/models/cierreCaja');

  try {
    // Guard: no correr dos veces sobre los mismos datos.
    const { rows: [prev] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM clientes WHERE ${ES_DNI_DEMO})::int AS clientes,
             (SELECT COUNT(*) FROM ventas WHERE ${esDemoTs('fecha_hora')})::int AS ventas,
             (SELECT COUNT(*) FROM movimientos_caja WHERE ${esDemoTs('fecha_hora')})::int AS movimientos,
             (SELECT COUNT(*) FROM cierre_caja WHERE ${ES_CIERRE_DEMO})::int AS cierres`);
    if (Object.values(prev).some((n) => n > 0)) {
      console.error(`Ya hay datos del seed demo en la base (${fmt(prev)}). Corré primero: node scripts/seed-demo-cleanup.js`);
      process.exitCode = 1;
      return;
    }

    // Usuarios activos reales (no los de los tests). Empleados primero para los turnos; admin/dueño para anulaciones.
    const { rows: usuarios } = await pool.query(`
      SELECT u.id, u.nombre, (r.es_admin OR r.descripcion = 'Dueño') AS es_jefe
      FROM usuarios u JOIN roles r ON r.id = u.id_rol
      WHERE u.activo = true AND u.email NOT LIKE 'test\\_%@example.test'
      ORDER BY (r.es_admin OR r.descripcion = 'Dueño'), u.created_at`);
    if (!usuarios.length) throw new Error('No hay usuarios activos para asignar los cobros/ventas');
    const ctxUsuarios = {
      manana: usuarios[0].id,
      tarde: (usuarios[1] ?? usuarios[0]).id,
      extra: (usuarios[2] ?? usuarios[1] ?? usuarios[0]).id,
      admin: (usuarios.find((x) => x.es_jefe) ?? usuarios[0]).id,
    };
    const nombreDe = (id) => usuarios.find((x) => x.id === id).nombre;

    const ctxProductos = {};
    const productosExistentes = [];
    for (const p of PRODUCTOS) {
      const { rows: [ex] } = await pool.query('SELECT id, nombre, precio FROM productos WHERE lower(nombre) = lower($1)', [p.nombre]);
      if (ex) {
        productosExistentes.push(ex.nombre);
        ctxProductos[p.key] = { id: ex.id, nombre: ex.nombre, precio: Number(ex.precio), creado: false };
      } else {
        ctxProductos[p.key] = { id: crypto.randomUUID(), nombre: p.nombre, precio: p.precio, creado: true };
      }
    }

    const rows = materializar(plan, { usuarios: ctxUsuarios, productos: ctxProductos });

    console.log(`Usuarios: mañana=${nombreDe(ctxUsuarios.manana)}, tarde=${nombreDe(ctxUsuarios.tarde)}, `
      + `suplente=${nombreDe(ctxUsuarios.extra)}, anulaciones=${nombreDe(ctxUsuarios.admin)}`);
    console.log('Insertando...');
    await withTransaction(async (client) => {
      for (const t of ['productos', 'clientes', 'pagos', 'pago_metodos', 'ventas', 'venta_items', 'venta_pagos',
        'movimientos_stock', 'movimientos_caja']) {
        await insertMany(client, t, rows[t]);
      }
    });

    // Cierres: los totales se calculan con el mismo modelo que usa la app (incluye cualquier dato real de
    // ese turno). Se saltean los turnos que ya tienen cierre.
    const { rows: existentes } = await pool.query(
      'SELECT fecha::text AS fecha, turno FROM cierre_caja WHERE fecha BETWEEN $1 AND $2', [plan.desde, plan.hoy]);
    const yaCerrados = new Set(existentes.map((c) => `${c.fecha}|${c.turno}`));
    const cierres = plan.cierres.filter((c) => !yaCerrados.has(`${c.fecha}|${c.turno}`));
    const cierreRows = [];
    for (const c of cierres) {
      const tot = await getTotalesTurno({ fecha: c.fecha, turno: c.turno });
      const creado = new Ts(c.fecha, c.turno === 'mañana' ? HORA_CORTE_TURNO * 60 + 5 : 22 * 60 + 10);
      cierreRows.push({
        id: crypto.randomUUID(), fecha: c.fecha, turno: c.turno,
        total_efectivo: tot.totalEfectivo, total_transferencia: tot.totalTransferencia, total_mixto: tot.totalMixto,
        total: tot.total, total_cuotas: tot.totalCuotas, total_ventas: tot.totalVentas,
        total_ingresos_extra: tot.totalIngresosExtra, total_egresos: tot.totalEgresos, cantidad_pagos: tot.cantidadPagos,
        empleados: JSON.stringify(tot.empleados), detalle: JSON.stringify({ ...tot.detalle, seedDemo: true }),
        creado_por: ctxUsuarios[c.usuario], created_at: creado,
      });
    }
    await withTransaction((client) => insertMany(client, 'cierre_caja', cierreRows));

    console.log('Listo. Se creó:');
    imprimirResumen(plan, rows, { cierres, productosExistentes });
    if (yaCerrados.size) console.log(`(${plan.cierres.length - cierres.length} turnos ya tenían cierre y se respetaron)`);
    console.log('\nPara deshacer: node scripts/seed-demo-cleanup.js');
  } finally {
    await pool.end();
  }
}

module.exports = { DNI_PREFIJO, MARCA_US, ES_DNI_DEMO, ES_CIERRE_DEMO, esDemoTs };

if (require.main === module) {
  main().catch((err) => {
    console.error('Error en el seed:', err.message);
    console.error('Si quedó a medias (p. ej. falló al generar los cierres), corré node scripts/seed-demo-cleanup.js');
    process.exitCode = 1;
  });
}
