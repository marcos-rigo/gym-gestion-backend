-- Fase 1 de Facturación: anulación de pagos con motivo + permiso facturacion_anular.
-- Idempotente: se puede volver a pegar y ejecutar sin romper nada.

alter table pagos
  add column if not exists anulado boolean not null default false,
  add column if not exists anulado_at timestamptz,
  add column if not exists anulado_por uuid references usuarios(id),
  add column if not exists motivo_anulacion text;

create index if not exists idx_pagos_anulado on pagos(anulado);

-- Permiso nuevo (no toca facturacion_ver / facturacion_cobrar, que ya existen).
insert into permisos (descripcion)
select 'facturacion_anular'
where not exists (select 1 from permisos where descripcion = 'facturacion_anular');

-- Se lo asigna a Admin (es_admin = true) y al rol "Dueño" exactamente como está
-- escrito en el seed de schema.sql. Empleado NO lo recibe por defecto.
insert into linea_permiso (id_rol, id_permiso)
select r.id, p.id
from roles r
join permisos p on p.descripcion = 'facturacion_anular'
where (r.es_admin = true or r.descripcion = 'Dueño')
  and not exists (
    select 1 from linea_permiso lp where lp.id_rol = r.id and lp.id_permiso = p.id
  );
