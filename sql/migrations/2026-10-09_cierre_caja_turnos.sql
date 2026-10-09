-- Cierre de caja por turno (mañana / tarde). Idempotente: se puede volver a pegar sin romper nada.
--
-- El turno NO se guarda en pagos ni en movimientos_caja: se deriva del timestamp al consultar
-- (HORA_CORTE_TURNO, ver src/utils/turno.js), igual que ya se deriva el día. Solo el cierre
-- guarda su turno, porque es un registro con snapshot de totales.
--
-- Cada (fecha, turno) se puede cerrar una sola vez: el UNIQUE convierte un segundo cierre en 23505
-- y el controller lo responde 409.

create table if not exists cierre_caja (
  id uuid primary key default gen_random_uuid(),
  fecha date not null,
  turno text not null check (turno in ('mañana', 'tarde')),
  total_efectivo numeric(10,2) not null default 0,
  total_transferencia numeric(10,2) not null default 0,
  total_mixto numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  cantidad_pagos int not null default 0,
  empleados jsonb not null default '[]'::jsonb,
  creado_por uuid references usuarios(id),
  created_at timestamptz not null default now(),
  constraint cierre_caja_fecha_turno_key unique (fecha, turno)
);
