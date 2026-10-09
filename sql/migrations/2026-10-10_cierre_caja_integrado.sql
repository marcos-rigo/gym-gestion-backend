-- Cierre de caja por turno integrado: cuotas + ventas + ingresos extra - egresos (espejo de /api/caja/cierre,
-- acotado al turno). Idempotente: se puede volver a pegar sin romper nada.
--
-- Cambios de significado en el snapshot (la tabla estaba vacía, no hay datos que reinterpretar):
--   - total_efectivo / total_transferencia: neto por método del turno (cuotas + ventas + ingresos extra - egresos),
--     con el desglose por componente (pago_metodos / venta_pagos), igual que el cierre integrado.
--   - total: neto del turno = total_cuotas + total_ventas + total_ingresos_extra - total_egresos.
--   - total_mixto: monto de cobros divididos (informativo; ya está incluido en efectivo/transferencia).
--   - detalle: desglose completo por fuente (cuotas, ventas, ingresos extra, egresos) por método.

alter table cierre_caja
  add column if not exists total_cuotas numeric(10,2) not null default 0,
  add column if not exists total_ventas numeric(10,2) not null default 0,
  add column if not exists total_ingresos_extra numeric(10,2) not null default 0,
  add column if not exists total_egresos numeric(10,2) not null default 0,
  add column if not exists detalle jsonb not null default '{}'::jsonb;
