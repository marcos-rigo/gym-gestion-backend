// Turno de caja: 'mañana' antes de HORA_CORTE_TURNO (hora local del gimnasio), 'tarde' desde ahí.
// Se deriva siempre del timestamp (no se guarda en pagos ni en movimientos_caja), así que cambiar
// HORA_CORTE_TURNO aplica a todo el historial. Única implementación: JS (turnoDeFecha) y SQL (turnoSql).
const { TZ, HORA_CORTE_TURNO } = require('../config/fechas');

const TURNOS = ['mañana', 'tarde'];

// Hora local (0-23) de un instante, en la zona del gimnasio.
function horaLocal(date) {
  const hora = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(date).find((p) => p.type === 'hour').value;
  return Number(hora);
}

function turnoDeFecha(date) {
  return horaLocal(new Date(date)) < HORA_CORTE_TURNO ? 'mañana' : 'tarde';
}

// Expresión SQL que devuelve el turno de una columna timestamptz. HORA_CORTE_TURNO es un entero
// validado en config/fechas.js, así que interpolarlo no abre inyección.
function turnoSql(columna) {
  return `(CASE WHEN EXTRACT(HOUR FROM (${columna} AT TIME ZONE '${TZ}')) < ${HORA_CORTE_TURNO}
    THEN 'mañana' ELSE 'tarde' END)`;
}

module.exports = { TURNOS, HORA_CORTE_TURNO, turnoDeFecha, turnoSql };
