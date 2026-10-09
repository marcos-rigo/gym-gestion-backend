// Fechas de negocio: todo se calcula en la zona horaria del gimnasio, no en UTC.
const TZ = process.env.APP_TIMEZONE || 'America/Argentina/Tucuman';
if (!/^[A-Za-z_/+-]+$/.test(TZ)) throw new Error(`APP_TIMEZONE inválida: ${TZ}`);

// Días de antelación para considerar una cuota "por vencer" (única fuente de verdad).
const POR_VENCER_DIAS = Number.parseInt(process.env.POR_VENCER_DIAS ?? '7', 10);
if (!Number.isInteger(POR_VENCER_DIAS) || POR_VENCER_DIAS < 0) throw new Error('POR_VENCER_DIAS inválida');

// Duración de un período de cuota.
const PERIODO_DIAS = 30;

// Hora (0-23, zona del gimnasio) en que empieza el turno "tarde". Antes = "mañana".
// Única fuente de verdad: los turnos se derivan de esta constante (ver src/utils/turno.js).
const HORA_CORTE_TURNO = Number.parseInt(process.env.HORA_CORTE_TURNO ?? '15', 10);
if (!Number.isInteger(HORA_CORTE_TURNO) || HORA_CORTE_TURNO < 0 || HORA_CORTE_TURNO > 23) {
  throw new Error('HORA_CORTE_TURNO inválida (entero entre 0 y 23)');
}

// Fecha de "hoy" en SQL, en la zona del gimnasio.
const HOY_SQL = `(now() AT TIME ZONE '${TZ}')::date`;

function hoyISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

module.exports = { TZ, POR_VENCER_DIAS, PERIODO_DIAS, HORA_CORTE_TURNO, HOY_SQL, hoyISO, addDays };
