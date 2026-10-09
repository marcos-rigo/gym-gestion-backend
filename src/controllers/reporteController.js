const cierreCaja = require('../models/cierreCaja');
const V = require('../utils/validators');
const { TZ, hoyISO, addDays } = require('../config/fechas');
const { TURNOS } = require('../utils/turno');
const { generarRecaudacionPdf } = require('../lib/recaudacionPdf');

const GYM_NOMBRE = process.env.GYM_NOMBRE || 'Colosseo Gym Barrio Norte';
const MAX_DIAS_RANGO = 366;

const recaudacionSchema = {
  desde: V.fecha('La fecha desde'),
  hasta: V.fecha('La fecha hasta'),
};

// PDF de recaudación de un rango de fechas (sin fechas = hoy; con una sola, ese día).
// Totales calculados con la misma lógica que el cierre por turno (cierreCaja), sin duplicarla.
async function recaudacionPdf(req, res) {
  try {
    const { ok, values: v, errors } = V.validate(req.query, recaudacionSchema, { partial: true });
    if (!ok) return V.sendValidationError(res, errors);

    const desde = v.desde || v.hasta || hoyISO();
    const hasta = v.hasta || v.desde || hoyISO();
    if (desde > hasta) {
      return V.sendValidationError(res, { hasta: 'La fecha hasta no puede ser anterior a la fecha desde' });
    }
    if (addDays(desde, MAX_DIAS_RANGO) < hasta) {
      return V.sendValidationError(res, { hasta: `El rango no puede superar los ${MAX_DIAS_RANGO} días` });
    }

    const dias = await cierreCaja.getTotalesPorDia({ desde, hasta });
    const periodo = cierreCaja.sumarTotales(dias.map((d) => d.totales));
    const turnos = desde === hasta
      ? await Promise.all(TURNOS.map(async (turno) => ({
        turno, totales: await cierreCaja.getTotalesTurno({ fecha: desde, turno }),
      })))
      : null;

    const generadoEn = new Date().toLocaleString('es-AR', {
      timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const pdf = await generarRecaudacionPdf({ gymNombre: GYM_NOMBRE, desde, hasta, generadoEn, periodo, dias, turnos });

    const nombre = desde === hasta ? `recaudacion_${desde}.pdf` : `recaudacion_${desde}_a_${hasta}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Content-Length': pdf.length,
    });
    return res.send(pdf);
  } catch (err) {
    console.error('reporte.recaudacionPdf error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}

module.exports = { recaudacionPdf };
