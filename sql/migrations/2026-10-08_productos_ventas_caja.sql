-- Fase 1 de Productos/Ventas/Caja: tablas nuevas + permisos nuevos + restricción de pagos.metodo.
-- Idempotente: se puede volver a pegar y ejecutar sin romper nada.
--
-- Pago dividido (parte efectivo / parte transferencia) en una misma venta o cuota:
-- no se modela con una columna "metodo" única en ventas/pagos, sino con una tabla hija
-- de desglose por método (venta_pagos / pago_metodos), igual que venta_items desglosa
-- una venta en líneas. La suma de las filas de desglose debe ser igual al total/monto
-- del padre; eso se valida en la capa de aplicación (en una transacción, igual que el
-- resto de las reglas de negocio de este repo), no con un trigger de Postgres.

-- ───────────────────────── Productos ─────────────────────────
create table if not exists productos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  descripcion text,
  categoria text,
  precio numeric(10,2) not null check (precio > 0),
  activo boolean not null default true,
  controla_stock boolean not null default false,
  stock_actual int,
  stock_minimo int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Nombre único case-insensitive entre productos (incluye inactivos: no se puede reactivar
-- ni crear uno nuevo con el mismo nombre que uno desactivado).
create unique index if not exists idx_productos_nombre_unico on productos (lower(nombre));

-- ───────────────────────── Ventas ─────────────────────────
-- Sin columna metodo_pago: el método (o la mezcla de métodos) vive en venta_pagos.
create table if not exists ventas (
  id uuid primary key default gen_random_uuid(),
  fecha_hora timestamptz not null default now(),
  id_usuario uuid references usuarios(id),
  id_cliente uuid references clientes(id),
  total numeric(10,2) not null,
  anulada boolean not null default false,
  motivo_anulacion text,
  anulada_por uuid references usuarios(id),
  anulada_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_ventas_fecha on ventas(fecha_hora);
create index if not exists idx_ventas_usuario on ventas(id_usuario);
create index if not exists idx_ventas_cliente on ventas(id_cliente);
create index if not exists idx_ventas_anulada on ventas(anulada);

create table if not exists venta_items (
  id uuid primary key default gen_random_uuid(),
  id_venta uuid not null references ventas(id) on delete cascade,
  id_producto uuid references productos(id),
  nombre_snapshot text not null,
  precio_unitario numeric(10,2) not null,
  cantidad int not null check (cantidad > 0),
  subtotal numeric(10,2) not null
);

create index if not exists idx_venta_items_venta on venta_items(id_venta);
create index if not exists idx_venta_items_producto on venta_items(id_producto);

-- Desglose de pago de una venta por método. Una venta en un solo método = una fila;
-- una venta dividida = una fila por método usado. sum(monto) de las filas de una venta
-- debe ser igual a ventas.total (lo garantiza el modelo dentro de la misma transacción
-- que inserta la venta).
create table if not exists venta_pagos (
  id uuid primary key default gen_random_uuid(),
  id_venta uuid not null references ventas(id) on delete cascade,
  metodo text not null check (metodo in ('efectivo', 'transferencia')),
  monto numeric(10,2) not null check (monto > 0)
);

create index if not exists idx_venta_pagos_venta on venta_pagos(id_venta);

-- ───────────────────────── Caja: egresos/ingresos extra y apertura ─────────────────────────
create table if not exists movimientos_caja (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('egreso', 'ingreso_extra')),
  concepto text not null,
  monto numeric(10,2) not null check (monto > 0),
  metodo text not null check (metodo in ('efectivo', 'transferencia')),
  fecha_hora timestamptz not null default now(),
  id_usuario uuid references usuarios(id),
  anulado boolean not null default false,
  motivo_anulacion text,
  anulado_por uuid references usuarios(id),
  anulado_at timestamptz
);

create index if not exists idx_movimientos_caja_fecha on movimientos_caja(fecha_hora);
create index if not exists idx_movimientos_caja_usuario on movimientos_caja(id_usuario);

create table if not exists caja_apertura (
  fecha date primary key,
  monto_inicial_efectivo numeric(10,2) not null check (monto_inicial_efectivo >= 0),
  id_usuario uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auditoría de ajustes de stock (ventas, anulaciones y correcciones manuales).
create table if not exists movimientos_stock (
  id uuid primary key default gen_random_uuid(),
  id_producto uuid not null references productos(id),
  tipo text not null check (tipo in ('venta', 'anulacion_venta', 'ajuste')),
  cantidad int not null,
  id_venta uuid references ventas(id),
  id_usuario uuid references usuarios(id),
  fecha_hora timestamptz not null default now()
);

create index if not exists idx_movimientos_stock_producto on movimientos_stock(id_producto);

-- ───────────────────────── Cuotas (pagos): mismo esquema de pago dividido ─────────────────────────
-- pagos.metodo se conserva (no se elimina la columna: la usan period/stats existentes y no
-- queremos migrar todo el código en esta fase), pero pasa a ser un resumen:
--   - 'efectivo' / 'transferencia' cuando el cobro se hizo en un solo método (caso de siempre),
--   - 'mixto' cuando se dividió entre varios métodos.
-- El desglose real para el cierre de caja vive siempre en pago_metodos, incluso para los pagos
-- de un solo método (se migran con el backfill de abajo), así el cierre de caja lee una sola
-- fuente de verdad sin tener que distinguir pagos viejos de pagos nuevos.
alter table pagos drop constraint if exists pagos_metodo_check;
alter table pagos add constraint pagos_metodo_check check (metodo in ('efectivo', 'transferencia', 'mixto'));

create table if not exists pago_metodos (
  id uuid primary key default gen_random_uuid(),
  id_pago uuid not null references pagos(id) on delete cascade,
  metodo text not null check (metodo in ('efectivo', 'transferencia')),
  monto numeric(10,2) not null check (monto > 0)
);

create index if not exists idx_pago_metodos_pago on pago_metodos(id_pago);

-- Backfill: todo pago existente (de un solo método) pasa a tener su fila equivalente en
-- pago_metodos. Es idempotente: solo inserta para pagos que todavía no tengan desglose.
insert into pago_metodos (id_pago, metodo, monto)
select p.id, p.metodo, p.monto
from pagos p
where p.metodo in ('efectivo', 'transferencia')
  and not exists (select 1 from pago_metodos pm where pm.id_pago = p.id);

-- ───────────────────────── Permisos nuevos ─────────────────────────
insert into permisos (descripcion)
select v.descripcion from (values
  ('productos_ver'), ('productos_crear'), ('productos_editar'), ('productos_eliminar'),
  ('ventas_ver'), ('ventas_registrar'), ('ventas_anular'),
  ('caja_ver'), ('caja_movimientos')
) as v(descripcion)
where not exists (select 1 from permisos where descripcion = v.descripcion);

-- Empleado recibe productos_ver, ventas_registrar y ventas_ver (no ventas_anular, ni caja_*).
insert into linea_permiso (id_rol, id_permiso)
select (select id from roles where descripcion = 'Empleado'), p.id
from permisos p
where p.descripcion in ('productos_ver', 'ventas_registrar', 'ventas_ver')
  and not exists (
    select 1 from linea_permiso lp
    where lp.id_rol = (select id from roles where descripcion = 'Empleado') and lp.id_permiso = p.id
  );
