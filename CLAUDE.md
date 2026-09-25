# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Express 5 REST API backend for a gym management system ("Gym-Gestion"), handling clients, payments/billing, users, roles/permissions, and a dashboard. Data lives in Postgres (Supabase-hosted); client photos are stored in Supabase Storage.

## Commands

- `npm start` — run the server (`node index.js`)
- `npm run dev` — run with `node --watch` for auto-restart on changes
- No test suite is configured (`npm test` is a stub).
- No lint script is configured.

The server reads `PORT` from `.env` (defaults to 4000 in code, but `.env` currently sets `PORT=3001`).

## Architecture

**Layering**: `routes/` → `middlewares/` (auth + permission checks) → `controllers/` (HTTP + validation + camelCase translation) → `models/` (raw SQL via `pg`). There is no ORM; all queries are hand-written SQL against the `pool` exported from `src/config/db.js`.

**snake_case ↔ camelCase boundary**: Postgres columns and request bodies from the model layer are snake_case. Controllers consistently do the conversion: they accept camelCase from the client, map to snake_case fields when calling models, and run responses through a local `toCamelCase(obj)` helper before sending JSON. This helper is duplicated per-controller (not shared) — follow the existing pattern in `clienteController.js` / `pagoController.js` when adding new controllers.

**Auth & permissions** (`src/middlewares/auth.js`, `src/middlewares/checkPermiso.js`):
- `auth` — verifies the JWT from `Authorization: Bearer <token>`, sets `req.user` from the token payload (`{ id, nombre, email, rol }`).
- `cargarRol` — must run after `auth`; looks up `id_rol` for `req.user.id` and attaches it as `req.user.id_rol`. Most protected routes chain `router.use(auth, cargarRol)`.
- `checkPermiso(permisoRequerido)` — per-route middleware factory. Looks up whether the user's role is `es_admin` (bypasses all checks) or has the named permission via the `linea_permiso` / `permisos` join tables. Permission strings follow a `<recurso>_<accion>` convention, e.g. `clientes_ver`, `clientes_crear`, `facturacion_cobrar`.
- `requireDueno` — simpler role gate used only for user management routes (`/api/usuarios`), requires `req.user.rol === 'dueno'` (checked directly from the JWT payload, no `cargarRol` needed).

**Route → permission map** (for reference when adding endpoints): clientes uses `clientes_ver/crear/editar/eliminar`; roles uses `roles_ver/crear/editar/eliminar`; pagos uses `facturacion_ver`/`facturacion_cobrar`. `/api/dashboard/stats` only requires `auth` (no permission check). `/api/usuarios/*` only requires the `dueno` role. `/api/upload/foto` has no auth at all.

**Business logic in SQL**: derived fields like a client's `estado_cuota` (`al_dia` / `por_vencer` / `moroso`) are computed in SQL `CASE` expressions repeated across `findAll`/`findById`/`findByDNI` in `src/models/cliente.js` rather than in JS — keep that pattern consistent if you touch cuota-status logic (vencimiento thresholds: overdue if `fecha_vencimiento < current_date`, "por vencer" if within 2 days for client queries / 7 days for stats and dashboard).

**File uploads**: `src/routes/upload.js` uses `multer` memory storage (5MB limit) and immediately forwards the buffer to `src/lib/supabaseStorage.js`, which uploads to the Supabase Storage bucket `fotos-clientes` and returns a public URL. This URL is then passed as `fotoUrl` when creating/updating a cliente — upload and cliente-record creation are two separate client-driven API calls, not atomic.

**Error handling convention**: controllers catch all errors, log with a `<domain>.<action> error:` prefix via `console.error`, and return generic `500 { message: 'Error interno del servidor' }` to the client. Domain-specific failures are signaled by models throwing errors with specific `.message` strings (e.g. `CLIENTE_NO_ENCONTRADO` in `pago.create`) that controllers pattern-match on to return the right status code.

## Environment

Required `.env` variables: `PORT`, `DATABASE_URL` (Postgres/Supabase connection string), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`. CORS is currently hardcoded in `index.js` to allow only `http://localhost:3000`.
