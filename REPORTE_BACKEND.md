# Reporte para el front: Productos, Ventas, Caja y pago dividido

Estado: `npm test` corre 264 tests, 0 fallas, DB de test limpia. Migración aplicada a la
base real (`sql/migrations/2026-10-08_productos_ventas_caja.sql`). Backup previo de `pagos`
en `backend/backup_pagos_2026-10-08.json`.

## Actualización (Fase 9, post-integración con el front)

El front reportó "ningún bug de backend". Igual, verificando a mano el contrato contra
`services/ventas.js` encontré y corregí 2 cosas en `/api/ventas*` (ninguna de las dos estaba
rompiendo nada visible en la UI actual, pero convenía corregirlas ahora):

1. **`anulada: false` viajaba como `anulada: null`** en toda respuesta de `/api/ventas*`. El
   `toCamelCase` recursivo que usa ese controller (es el único recursivo del backend, para poder
   camelCasear `items`/`pagos` anidados) trataba cualquier valor "falsy" como vacío, incluido el
   booleano `false`. `services/ventas.js` no lo notaba porque `!!null === false`, pero el dato
   que mandaba el servidor era incorrecto. Corregido: ahora solo `null`/`undefined` se tratan
   como vacío.
2. **El detalle de una venta (`POST /api/ventas` y `GET /api/ventas/:id`) no traía
   `usuarioNombre` ni `clienteNombreCompleto`**, aunque `services/ventas.js` los espera con esos
   nombres exactos; el listado (`GET /api/ventas`) sí traía info de nombre, pero como
   `clienteNombre`/`clienteApellido` separados (nunca combinados). Ahora los tres (crear, detalle,
   listado) devuelven siempre `usuarioNombre` y `clienteNombreCompleto` (formato `"Apellido, Nombre"`,
   `null` si la venta no tiene cliente asociado).

Convenciones que ya conocías y siguen igual: JWT `Authorization: Bearer <token>`, body/response
en camelCase (el backend traduce desde/hacia snake_case de Postgres), errores de validación
`400 { message, errors: { campo: mensaje } }`, duplicados `409 { message, errors: { campo } }`,
ids UUID, fechas `YYYY-MM-DD`, montos como number con hasta 2 decimales. Paginación: query
`page`/`pageSize` (default 1/20, máx 100), response `{ data, meta: { page, pageSize, total, ...} }`.

**Importante — un detalle de shape que es distinto al resto de la API**: en `GET/POST /api/ventas*`
los objetos anidados (`items`, `pagos` dentro de una venta) también vienen en camelCase (conversión
recursiva). En cambio, en el resto de los endpoints (`pagos`, `caja/movimientos`, etc.) solo el
objeto de primer nivel se convierte a camelCase — no hay objetos anidados con columnas propias en
esos casos, así que no aplica.

---

## Cambio de negocio: `pagos.metodo` ya no acepta `"tarjeta"`

Antes: `'efectivo' | 'tarjeta' | 'transferencia'`. Ahora: `'efectivo' | 'transferencia' | 'mixto'`.
`'mixto'` es un valor nuevo que el servidor asigna solo cuando el cobro se dividió entre dos
métodos (ver más abajo). Si el front todavía manda `metodo: 'tarjeta'` en `POST /api/pagos`,
ahora va a recibir `400`.

---

## Productos — `/api/productos`

Permisos: `productos_ver` (GET), `productos_crear` (POST), `productos_editar` (PUT, toggle-activo,
stock), `productos_eliminar` (DELETE). Admin bypassa todo. Empleado tiene `productos_ver` por defecto.

### GET /api/productos?query=&activo=true|false&page=&pageSize=
```json
{ "data": [ { "id": "...", "nombre": "Mancuerna 5kg", "descripcion": null, "categoria": "Accesorios",
  "precio": "1500.00", "activo": true, "controlaStock": true, "stockActual": 10, "stockMinimo": 2,
  "createdAt": "...", "updatedAt": "..." } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1 } }
```
`precio` llega como string (numeric de Postgres, igual que `pagos.monto` ya te llegaba así). Si no
se manda `activo`, trae activos e inactivos.

### GET /api/productos/:id → 200 `{ data }` | 404

### POST /api/productos
Body: `{ nombre, descripcion?, categoria?, precio, controlaStock?, stockActual?, stockMinimo? }`.
- `nombre`: 2-60 caracteres, **solo letras, números y espacios** (sin guiones ni apóstrofes).
- `precio`: número > 0, hasta 2 decimales.
- `descripcion`: hasta 200 caracteres. `categoria`: hasta 50.
- `controlaStock` (boolean, default `false`). Si es `true` y no mandás `stockActual`, arranca en 0.
- Nombre duplicado (sin importar mayúsculas), incluso contra uno **desactivado** → `409 { errors: { nombre } }`.
- 201 `{ data }`.

### PUT /api/productos/:id
Mismo body que el alta, parcial (solo mandás lo que cambia). 404 si no existe, 409 si el nuevo
nombre ya lo usa otro producto.

### DELETE /api/productos/:id — "eliminar" = desactivar
200 `{ data }` con `activo: false`. No borra la fila (se preserva el historial de ventas que la
referencian). 404 si no existe.

### PATCH /api/productos/:id/toggle-activo
Invierte `activo`. Útil para reactivar. 200 `{ data }`, 404 si no existe.

### PATCH /api/productos/:id/stock — ajuste manual auditado
Body: `{ delta, motivo? }` (entero, puede ser negativo; `0` → 400). Requiere `controlaStock: true`
en el producto (si no, 409). Si el resultado quedaría negativo → 409. Queda una fila en
`movimientos_stock` (tabla interna, no expuesta por API todavía) con `tipo: 'ajuste'`.
200 `{ data }` (producto actualizado) | 404 | 409.

---

## Ventas — `/api/ventas` (pago dividido)

Permisos: `ventas_ver` (GET), `ventas_registrar` (POST), `ventas_anular` (POST .../anular).
Empleado tiene `ventas_ver` + `ventas_registrar` por defecto, **no** `ventas_anular`.

### POST /api/ventas
```json
{
  "items": [ { "idProducto": "uuid", "cantidad": 2 } ],
  "pagos": [ { "metodo": "efectivo", "monto": 200 }, { "metodo": "transferencia", "monto": 100 } ],
  "idCliente": "uuid-opcional"
}
```
- **El precio nunca lo manda el front.** El servidor lo toma del producto en el momento de la
  venta; cualquier `precio` que venga en un item se ignora.
- `items`: al menos 1, `cantidad` entero > 0. Producto inexistente → 404. Producto inactivo → 409.
- `pagos`: al menos 1, `metodo` en `efectivo|transferencia`, `monto` > 0 con hasta 2 decimales.
  **La suma de `pagos` tiene que ser exactamente igual al total calculado por el servidor** (suma
  de `precio del producto × cantidad`); si no coincide → `400 { errors: { pagos: "..." } }`.
- Si `controlaStock` del producto es `true` y no hay stock suficiente → `409 { message, productoId }`.
- Todo es una transacción: si cualquier ítem falla, no se crea nada (ni la venta, ni se toca stock).
- 201:
```json
{ "data": { "id": "...", "fechaHora": "...", "idUsuario": "...", "usuarioNombre": "Juan Pérez",
  "idCliente": null, "clienteNombreCompleto": null, "total": "300.00",
  "anulada": false, "motivoAnulacion": null, "anuladaPor": null, "anuladaAt": null, "createdAt": "...",
  "items": [ { "id": "...", "idProducto": "...", "nombreSnapshot": "Mancuerna 5kg", "precioUnitario": "100.00", "cantidad": 2, "subtotal": "200.00" } ],
  "pagos": [ { "id": "...", "metodo": "efectivo", "monto": "200.00" }, { "id": "...", "metodo": "transferencia", "monto": "100.00" } ] } }
```
`nombreSnapshot`/`precioUnitario` quedan congelados: si después cambiás el precio o nombre del
producto, las ventas viejas no se alteran. `usuarioNombre`/`clienteNombreCompleto` (este último
`"Apellido, Nombre"`, o `null` si la venta no tiene cliente asociado) vienen siempre, tanto en
esta respuesta como en el detalle (`GET /api/ventas/:id`) y en el listado — **corregido durante
la Fase 9**: antes el detalle no los traía y el listado los exponía bajo otros nombres
(`clienteNombre`/`clienteApellido` separados, sin combinar).

### GET /api/ventas?desde=&hasta=&usuarioId=&anuladas=true|false&page=&pageSize=
200 `{ data: [venta...], meta }`. Cada venta trae `items`/`pagos` igual que el POST (mismo shape,
incluyendo `usuarioNombre`/`clienteNombreCompleto`).

### GET /api/ventas/:id → 200 `{ data }` | 404

### POST /api/ventas/:id/anular
Body: `{ motivo }` (requerido, hasta 300 caracteres). Restituye el stock de los ítems con
`controlaStock: true`. 409 si ya estaba anulada. 404 si no existe. 200 `{ data }`.

### GET /api/ventas/reportes?desde=&hasta=
Excluye ventas anuladas.
```json
{ "data": {
  "porProducto": [ { "idProducto": "...", "nombre": "Mancuerna 5kg", "unidades": 10, "ingreso": 1000 } ],
  "porDia": [ { "fecha": "2026-10-08", "cantidad": 3, "total": 450 } ]
} }
```

---

## Cuotas (`/api/pagos`) — pago dividido, compatible con el front viejo

### POST /api/pagos — dos formas de mandar el método

**Forma vieja (sigue funcionando igual, no rompe nada):**
```json
{ "clienteId": "uuid", "monto": 15000, "metodo": "efectivo" }
```

**Forma nueva (pago dividido), en vez de `metodo` mandás `pagos`:**
```json
{ "clienteId": "uuid", "monto": 15000, "pagos": [ { "metodo": "efectivo", "monto": 9000 }, { "metodo": "transferencia", "monto": 6000 } ] }
```
- Si mandás un solo elemento en `pagos`, se comporta igual que la forma vieja con ese método.
- Si mandás dos métodos distintos, el `metodo` resultante del pago queda en `"mixto"` y el
  desglose real queda en el campo `metodos` de la respuesta (ver abajo).
- La suma de `pagos` tiene que ser igual a `monto` → si no, `400 { errors: { pagos } }`.
- Tenés que mandar **o** `metodo` **o** `pagos` (no ninguno) → si no mandás ninguno, `400 { errors: { metodo } }`.

Response (201), nota el campo nuevo `metodos`:
```json
{ "data": { "id": "...", "clienteId": "...", "usuarioId": "...", "monto": "15000.00", "metodo": "mixto",
  "periodoDesde": "...", "periodoHasta": "...", "fechaPago": "...",
  "metodos": [ { "metodo": "efectivo", "monto": 9000 }, { "metodo": "transferencia", "monto": 6000 } ] } }
```
`metodos` también viene ahora en `GET /api/pagos` y `GET /api/pagos/cliente/:clienteId` (incluso
para pagos viejos de un solo método: se migraron automáticamente, siempre va a tener al menos 1 elemento).

Todo lo demás de pagos (anulación, stats, cierre-caja) sigue funcionando exactamente igual que antes.

---

## Caja — `/api/caja` (nuevo)

Permisos: `caja_ver` (GET), `caja_movimientos` (POST/PUT). Ninguno de los dos lo tiene Empleado
por defecto — hay que asignarlo manualmente desde Roles si se quiere que un empleado vea u opere caja.

### POST /api/caja/movimientos — registrar un egreso o ingreso extra
Body: `{ tipo: "egreso"|"ingreso_extra", concepto, monto, metodo: "efectivo"|"transferencia" }`.
201 `{ data }`.

### GET /api/caja/movimientos?fecha=&tipo=
Si no mandás `fecha`, usa hoy (zona Tucumán). Empleado (sin rol Admin/Dueño) ve solo lo que
registró él mismo; Admin/Dueño ven todo. 200 `{ data: [movimiento...] }`.

### POST /api/caja/movimientos/:id/anular
Body: `{ motivo }` (requerido). 409 si ya estaba anulado, 404 si no existe.

### GET /api/caja/apertura?fecha= → 200 `{ data }` (o `data: null` si no se registró apertura ese día)

### PUT /api/caja/apertura — fija el efectivo inicial del día (upsert, una fila por fecha)
Body: `{ fecha?, montoInicialEfectivo }` (sin `fecha` usa hoy). `montoInicialEfectivo` puede ser
`0` (caja en cero), no puede ser negativo. 200 `{ data }`.

### GET /api/caja/cierre?fecha= — cierre de caja integrado (cuotas + ventas + caja)
Scoping igual que arriba: Empleado ve solo lo suyo, Admin/Dueño ven todo (decidido en el servidor,
el front no necesita mandar nada para esto). Si no mandás `fecha`, usa hoy.

```json
{ "data": {
  "fecha": "2026-10-08",
  "aperturaInicialEfectivo": 1000,
  "efectivoEsperado": 1080,
  "transferenciasTotal": 90,
  "porTipo": {
    "cuotas":        { "efectivo": 60, "transferencia": 40, "cantidad": 1 },
    "ventas":        { "efectivo": 70, "transferencia": 30, "cantidad": 1 },
    "egresos":       { "efectivo": 50, "transferencia": 0,  "cantidad": 1 },
    "ingresosExtra": { "efectivo": 0,  "transferencia": 20, "cantidad": 1 }
  },
  "porEmpleado": [
    { "usuarioId": "...", "usuarioNombre": "...", "cuotas": { "monto": 100, "cantidad": 1 }, "ventas": { "monto": 100, "cantidad": 1 } }
  ],
  "anulados": {
    "cuotas": { "cantidad": 0, "monto": 0 },
    "ventas": { "cantidad": 0, "monto": 0 }
  }
} }
```
Fórmula: `efectivoEsperado = aperturaInicialEfectivo + cuotas.efectivo + ventas.efectivo + ingresosExtra.efectivo − egresos.efectivo`.
`transferenciasTotal` es la misma cuenta pero con los montos en transferencia. Los `anulados` son
informativos y **no** entran en ninguna de las dos cuentas de arriba.

**El endpoint viejo `GET /api/pagos/cierre-caja` sigue funcionando exactamente igual que antes**
(cierre solo de cuotas) — no lo tocamos, por si el front todavía lo usa en algún lado. Para el
cierre completo (cuotas + ventas + caja) usar `/api/caja/cierre`.

---

## Dashboard — `/api/dashboard/stats` (dos campos nuevos)
```json
{ "data": { "...": "...", "ventasHoyTotal": 330, "ventasHoyCantidad": 3 } }
```
Suma de ventas no anuladas de hoy (zona Tucumán).

---

## Permisos nuevos (para la pantalla de Roles)
`productos_ver`, `productos_crear`, `productos_editar`, `productos_eliminar`,
`ventas_ver`, `ventas_registrar`, `ventas_anular`, `caja_ver`, `caja_movimientos`.
Admin los tiene todos automáticamente. Empleado viene de fábrica con `productos_ver`,
`ventas_registrar`, `ventas_ver` (nada de `ventas_anular` ni de `caja_*`).

## Decisiones tomadas sin consultar (quedan anotadas, avisar si hay que cambiarlas)
- `pagos.metodo = 'tarjeta'` se eliminó como valor válido (no había datos reales usándolo).
- "Eliminar" producto = desactivar; el nombre sigue siendo único globalmente (activos e inactivos),
  así que no se puede reactivar un producto con el mismo nombre que otro ya existente, ni crear
  uno nuevo que choque con uno desactivado.
- `venta_items.idProducto` puede en teoría quedar huérfano si algún día se permite borrar productos
  de verdad (hoy no se puede: "eliminar" siempre desactiva). No es un caso real hoy.
- El desglose por método de una venta/cuota dividida no tiene límite de cantidad de métodos más
  allá de `efectivo`/`transferencia` (no hay un tercer método todavía).
