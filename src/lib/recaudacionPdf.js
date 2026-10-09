// Render del PDF de recaudación (solo presentación: los datos llegan ya calculados desde
// cierreCaja.getTotalesPorDia / getTotalesTurno / sumarTotales). Usa las fuentes estándar de PDFKit
// (Helvetica, WinAnsi), que cubren tildes y ñ sin embeber archivos de fuente.
const PDFDocument = require('pdfkit');

const MARGEN = 40;
const ALTO_FILA = 20;
const PAD = 5;
const GRIS_HEADER = '#e9ecef';
const GRIS_TOTAL = '#f5f5f5';
const BORDE = '#9ca3af';

const moneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });
const pesos = (n) => moneda.format(n || 0).replace(/ /g, ' ');
const fechaCorta = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const diaSemana = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-AR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');

// Tabla con bordes. columns: [{ header, width, align }]; rows: [{ cells: [...], bold?, fill? }].
// Corta página cuando no entra la fila y repite el encabezado.
function tabla(doc, columns, rows) {
  const x0 = MARGEN;
  const limite = () => doc.page.height - MARGEN - 20; // deja lugar al pie de página

  const fila = (cells, { bold = false, fill = null } = {}) => {
    if (doc.y + ALTO_FILA > limite()) doc.addPage();
    const y = doc.y;
    let x = x0;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    columns.forEach((col, i) => {
      if (fill) doc.rect(x, y, col.width, ALTO_FILA).fill(fill);
      doc.lineWidth(0.5).strokeColor(BORDE).rect(x, y, col.width, ALTO_FILA).stroke();
      doc.fillColor('#111111').text(String(cells[i] ?? ''), x + PAD, y + 6, {
        width: col.width - PAD * 2, align: col.align ?? 'left', lineBreak: false,
      });
      x += col.width;
    });
    doc.x = x0;
    doc.y = y + ALTO_FILA;
  };

  const encabezado = () => fila(columns.map((c) => c.header), { bold: true, fill: GRIS_HEADER });
  encabezado();
  for (const r of rows) {
    if (doc.y + ALTO_FILA > limite()) { doc.addPage(); encabezado(); }
    fila(r.cells, { bold: r.bold, fill: r.fill ?? (r.bold ? GRIS_TOTAL : null) });
  }
  doc.moveDown(0.8);
}

function titulo(doc, texto) {
  if (doc.y + 60 > doc.page.height - MARGEN) doc.addPage();
  doc.moveDown(0.4).font('Helvetica-Bold').fontSize(12).fillColor('#111111').text(texto, MARGEN);
  doc.moveDown(0.3);
}

function nota(doc, texto) {
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#555555').text(texto, MARGEN);
  doc.fillColor('#111111').moveDown(0.6);
}

// datos: { gymNombre, desde, hasta, generadoEn, periodo, dias: [{ fecha, totales }], turnos?: [{ turno, totales }] }
function generarRecaudacionPdf({ gymNombre, desde, hasta, generadoEn, periodo, dias, turnos }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGEN, bufferPages: true, info: { Title: `Recaudación ${desde} a ${hasta}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ancho = doc.page.width - MARGEN * 2;

    // Encabezado
    doc.font('Helvetica-Bold').fontSize(18).text(gymNombre, MARGEN, MARGEN);
    doc.font('Helvetica').fontSize(12).text('Reporte de recaudación');
    doc.moveDown(0.3).fontSize(10).fillColor('#333333')
      .text(desde === hasta ? `Fecha: ${fechaCorta(desde)}` : `Período: ${fechaCorta(desde)} al ${fechaCorta(hasta)}`)
      .text(`Generado: ${generadoEn}`);
    doc.fillColor('#111111').moveDown(0.5);
    doc.lineWidth(1).strokeColor('#111111').moveTo(MARGEN, doc.y).lineTo(MARGEN + ancho, doc.y).stroke();
    doc.moveDown(0.8);

    // Resumen del período
    const d = periodo.detalle;
    titulo(doc, 'Resumen del período');
    tabla(doc, [
      { header: 'Concepto', width: ancho * 0.55 },
      { header: 'Cantidad', width: ancho * 0.15, align: 'right' },
      { header: 'Monto', width: ancho * 0.30, align: 'right' },
    ], [
      { cells: ['Cuotas', d.cuotas.cantidad, pesos(periodo.totalCuotas)] },
      { cells: ['Ventas de kiosco', d.ventas.cantidad, pesos(periodo.totalVentas)] },
      { cells: ['Ingresos extra', '', pesos(periodo.totalIngresosExtra)] },
      { cells: ['Egresos', '', pesos(-periodo.totalEgresos)] },
      { cells: ['Total neto', '', pesos(periodo.total)], bold: true },
    ]);

    // Desglose por método
    titulo(doc, 'Desglose por método de pago');
    const filaMetodo = (nombre, x, signo = 1) => ({
      cells: [nombre, pesos(signo * x.efectivo), pesos(signo * x.transferencia), pesos(signo * (x.efectivo + x.transferencia))],
    });
    tabla(doc, [
      { header: 'Concepto', width: ancho * 0.31 },
      { header: 'Efectivo', width: ancho * 0.23, align: 'right' },
      { header: 'Transferencia', width: ancho * 0.23, align: 'right' },
      { header: 'Total', width: ancho * 0.23, align: 'right' },
    ], [
      filaMetodo('Cuotas', d.cuotas),
      filaMetodo('Ventas de kiosco', d.ventas),
      filaMetodo('Ingresos extra', d.ingresosExtra),
      filaMetodo('Egresos', d.egresos, -1),
      { cells: ['Neto', pesos(periodo.totalEfectivo), pesos(periodo.totalTransferencia), pesos(periodo.total)], bold: true },
    ]);
    nota(doc, `Cobros de cuotas mixtos: ${pesos(periodo.totalMixto)} (ya incluidos en efectivo y transferencia según su desglose).`);

    // Columnas compartidas por las tablas de turnos y días
    const colsMovimientos = (primera) => [
      { header: primera, width: ancho * 0.20 },
      { header: 'Cuotas', width: ancho * 0.16, align: 'right' },
      { header: 'Ventas', width: ancho * 0.16, align: 'right' },
      { header: 'Ing. extra', width: ancho * 0.16, align: 'right' },
      { header: 'Egresos', width: ancho * 0.16, align: 'right' },
      { header: 'Neto', width: ancho * 0.16, align: 'right' },
    ];
    const celdas = (etiqueta, t) => [
      etiqueta, pesos(t.totalCuotas), pesos(t.totalVentas), pesos(t.totalIngresosExtra), pesos(-t.totalEgresos), pesos(t.total),
    ];

    if (turnos) {
      titulo(doc, 'Desglose por turno');
      tabla(doc, colsMovimientos('Turno'), [
        ...turnos.map(({ turno, totales }) => ({ cells: celdas(turno === 'mañana' ? 'Mañana' : 'Tarde', totales) })),
        { cells: celdas('Total', periodo), bold: true },
      ]);
    }

    titulo(doc, 'Movimientos día por día');
    if (dias.length === 0) {
      nota(doc, 'No hay movimientos vigentes en el período.');
    } else {
      tabla(doc, colsMovimientos('Fecha'), [
        ...dias.map(({ fecha, totales }) => ({ cells: celdas(`${diaSemana(fecha)} ${fechaCorta(fecha)}`, totales) })),
        { cells: celdas('Total', periodo), bold: true },
      ]);
      nota(doc, 'Se omiten los días sin movimientos. No incluye cobros, ventas ni movimientos anulados.');
    }

    // Pie con numeración de páginas
    const rango = doc.bufferedPageRange();
    for (let i = 0; i < rango.count; i++) {
      doc.switchToPage(rango.start + i);
      doc.page.margins.bottom = 0; // si no, escribir dentro del margen inferior agrega una página
      doc.font('Helvetica').fontSize(8).fillColor('#555555').text(
        `${gymNombre} · Recaudación · Página ${i + 1} de ${rango.count}`,
        MARGEN, doc.page.height - MARGEN, { width: ancho, align: 'center', lineBreak: false }
      );
    }
    doc.end();
  });
}

module.exports = { generarRecaudacionPdf };
