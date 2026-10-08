# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Express 5 REST API backend for a gym management system ("Gym-Gestion"), handling clients, payments/billing, users, roles/permissions, and a dashboard. Data lives in Postgres (Supabase-hosted); client photos are stored in Supabase Storage.

## Commands

- `npm start` — run the server (`node index.js`)
- `npm run dev` — run with `node --watch` for auto-restart on changes
- `npm test` — smoke test de toda la API (`scripts/smoke-test.js`, `node:test`). Levanta la app en un puerto libre, crea sus propios usuarios/roles de prueba directo en la DB (marca: emails `test_*@example.test`, observaciones `TEST_*`, roles `Zztest*`) y los borra al final. Corre contra la DB real configurada en `.env`; no toca al superadmin. `TEST_BASE_URL` apunta a un servidor ya levantado (se saltea el test del superadmin protegido).
- No lint script is configured.

The server reads `PORT` from `.env` (defaults to 4000 in code, but `.env` currently sets `PORT=3001`).

## Architecture

**Layering**: `index.js` (listen) / `app.js` (express app, CORS, handler de errores JSON; lo reutiliza el test) → `routes/` → `middlewares/` (auth + permission checks) → `controllers/` (HTTP + validation + camelCase translation) → `models/` (raw SQL via `pg`). There is no ORM; all queries are hand-written SQL against the `pool` exported from `src/config/db.js`.

**Validation**: todos los controllers validan con `src/utils/validators.js` (`V.validate(body, schema, { partial })`) antes de llamar al modelo. Error de validación = `400 { message, errors: { campo: 'mensaje' } }`; duplicados = `409 { message, errors: { campo } }` (también se mapea el `23505` de Postgres). Los ids son UUID: las rutas usan `router.param('id', uuidParam)`. Reglas de negocio de fechas (zona horaria `APP_TIMEZONE`, `POR_VENCER_DIAS`, `PERIODO_DIAS`, `HOY_SQL`) viven en `src/config/fechas.js`.

**snake_case ↔ camelCase boundary**: Postgres columns and request bodies from the model layer are snake_case. Controllers consistently do the conversion: they accept camelCase from the client, map to snake_case fields when calling models, and run responses through a local `toCamelCase(obj)` helper before sending JSON. This helper is duplicated per-controller (not shared) — follow the existing pattern in `clienteController.js` / `pagoController.js` when adding new controllers.

**Auth & permissions** (`src/middlewares/auth.js`, `src/middlewares/checkPermiso.js`):
- `auth` — verifies (HS256 only) the JWT from `Authorization: Bearer <token>`, sets `req.user` from the token payload (`{ id, nombre, email }` — the JWT no longer carries a role).
- `cargarRol` — must run after `auth`; looks up `id_rol` for `req.user.id`, attaches it as `req.user.id_rol`, and rejects deleted/deactivated users with 401 even if their token is still valid. Most protected routes chain `router.use(auth, cargarRol)`.
- `checkPermiso(permisoRequerido)` — per-route middleware factory. Looks up whether the user's role is `es_admin` (bypasses all checks) or has the named permission via the `linea_permiso` / `permisos` join tables. Permission strings follow a `<recurso>_<accion>` convention, e.g. `clientes_ver`, `clientes_crear`, `facturacion_cobrar`.
- `requireDueno` — gate used only for user management routes (`/api/usuarios`). Queries the DB for the user's role and allows it if `roles.es_admin` is true or `roles.descripcion === 'Dueño'` (no `cargarRol` needed); also sets `req.user.es_admin`. Un Dueño que no es Admin no puede crear, asignar ni modificar usuarios con rol Admin.

**Route → permission map** (for reference when adding endpoints): clientes uses `clientes_ver/crear/editar/eliminar`; roles uses `roles_ver/crear/editar/eliminar`; pagos uses `facturacion_ver`/`facturacion_cobrar`. `/api/dashboard/stats` requires `estadisticas_ver`; `/api/upload/foto` requires `clientes_crear` or `clientes_editar` (`checkPermiso` acepta varios y exige al menos uno). `/api/usuarios/*` requires Admin or the Dueño role.

**Users & roles**: `usuarios` reference `roles` via `id_rol` (there is no `rol` string column anymore); user create/update accept `idRol` and responses include `rolDescripcion`/`esAdmin`. The last active admin can't be demoted or deactivated.

**Protected superadmin**: the user whose email equals `SUPERADMIN_EMAIL` (env, defaults to `marcos.rigo.10@gmail.com`) is returned by `usuario.findAll/findById` with `protegido: true`. `update`, `toggleActivo` and `remove` in `usuarioController.js` return 403 for it — it stays visible but is only changeable directly in the DB. Keep this check in any new user-mutating endpoint.

**Business logic in SQL**: derived fields like a client's `estado_cuota` (`al_dia` / `por_vencer` / `moroso`) are computed in SQL `CASE` expressions repeated across `findAll`/`findById`/`findByDNI` in `src/models/cliente.js` rather than in JS — keep that pattern consistent if you touch cuota-status logic (single definition `ESTADO_CUOTA_SQL` in `models/cliente.js`, reused by listados, stats y próximos vencimientos: moroso si `fecha_vencimiento < hoy`, por vencer dentro de `POR_VENCER_DIAS` (default 7); "hoy" se calcula en la zona horaria del gimnasio, no en UTC).

**File uploads**: `src/routes/upload.js` uses `multer` memory storage (5MB limit) and immediately forwards the buffer to `src/lib/supabaseStorage.js`, which uploads to the Supabase Storage bucket `fotos-clientes` and returns a public URL. This URL is then passed as `fotoUrl` when creating/updating a cliente — upload and cliente-record creation are two separate client-driven API calls, not atomic.

**Error handling convention**: controllers catch all errors, log with a `<domain>.<action> error:` prefix via `console.error`, and return generic `500 { message: 'Error interno del servidor' }` to the client. Domain-specific failures are signaled by models throwing errors with specific `.message` strings (e.g. `CLIENTE_NO_ENCONTRADO` in `pago.create`) that controllers pattern-match on to return the right status code.

## Environment

Required `.env` variables: `PORT`, `CORS_ORIGIN` (orígenes separados por coma; default `http://localhost:3000`), `SUPERADMIN_EMAIL`, `APP_TIMEZONE`, `POR_VENCER_DIAS` (los tres opcionales; ver `.env.example`), `DATABASE_URL` (Postgres/Supabase connection string), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`. `app.js` aborta al iniciar si faltan las requeridas.

**Infra**: Render aloja únicamente el servicio Express (sin Postgres propio) — el Postgres que Render provisiona al crear el servicio no se usa. Supabase Postgres es la única base de datos (y también Supabase Storage para `fotos-clientes`); `DATABASE_URL` en Render debe apuntar al connection string de Supabase, igual que en `.env` local.
