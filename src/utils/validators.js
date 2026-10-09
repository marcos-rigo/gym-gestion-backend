// Validaciones compartidas por todos los controllers.
//
// Cada regla es una función (raw, ctx) => SKIP | { value } | { error }:
//   - raw === undefined  -> campo no enviado (error si es required y no es partial; si no, se omite)
//   - raw === null / ''  -> se interpreta como "vaciar" el campo (error si es required)
//   - en otro caso       -> se parsea/normaliza con la regla concreta
// `validate(body, schema, { partial })` devuelve { ok, values, errors } con los valores ya normalizados.

const { hoyISO } = require('../config/fechas');

const SKIP = Symbol('skip');
const REQUIRED_MSG = 'Este campo es requerido';

function rule(parse, { required = false } = {}) {
  return (raw, ctx = {}) => {
    if (raw === undefined) return required && !ctx.partial ? { error: REQUIRED_MSG } : SKIP;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      return required ? { error: REQUIRED_MSG } : { value: null };
    }
    return parse(raw);
  };
}

const NAME_RE = /^\p{L}+(?:[ '’-]\p{L}+)*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Nombre, apellido, descripción de rol: letras (con tildes/ñ), espacios, guion y apóstrofe. 2-50.
const nombre = (label, opts) => rule((raw) => {
  if (typeof raw !== 'string') return { error: `${label} debe ser texto` };
  const v = raw.trim().replace(/\s+/g, ' ');
  if (v.length < 2 || v.length > 50) return { error: `${label} debe tener entre 2 y 50 caracteres` };
  if (!NAME_RE.test(v)) return { error: `${label} solo puede contener letras, espacios, guion y apóstrofe` };
  return { value: v };
}, opts);

// DNI: 7 u 8 dígitos.
const dni = (opts) => rule((raw) => {
  const v = typeof raw === 'number' ? String(raw) : raw;
  if (typeof v !== 'string' || !/^\d{7,8}$/.test(v.trim())) {
    return { error: 'El DNI debe tener 7 u 8 dígitos (solo números)' };
  }
  return { value: v.trim() };
}, opts);

// Teléfono: dígitos con "+" inicial opcional, 8-15 dígitos.
const telefono = (opts) => rule((raw) => {
  const v = typeof raw === 'number' ? String(raw) : raw;
  if (typeof v !== 'string' || !/^\+?\d{8,15}$/.test(v.trim())) {
    return { error: 'El teléfono debe tener entre 8 y 15 dígitos (se permite un + inicial)' };
  }
  return { value: v.trim() };
}, opts);

// Email: formato válido, trim + lowercase, máx 100.
const email = (opts) => rule((raw) => {
  if (typeof raw !== 'string') return { error: 'El email debe ser texto' };
  const v = raw.trim().toLowerCase();
  if (v.length > 100) return { error: 'El email no puede superar los 100 caracteres' };
  if (!EMAIL_RE.test(v)) return { error: 'El email no tiene un formato válido' };
  return { value: v };
}, opts);

// Contraseña de alta: 8-72 caracteres (72 = límite de bcrypt), al menos 1 letra y 1 número.
const password = (opts) => rule((raw) => {
  if (typeof raw !== 'string') return { error: 'La contraseña debe ser texto' };
  if (raw.length < 8) return { error: 'La contraseña debe tener al menos 8 caracteres' };
  if (raw.length > 72) return { error: 'La contraseña no puede superar los 72 caracteres' };
  if (!/\p{L}/u.test(raw) || !/\d/.test(raw)) {
    return { error: 'La contraseña debe incluir al menos una letra y un número' };
  }
  return { value: raw };
}, opts);

// Monto: número > 0, máx 2 decimales, cabe en numeric(10,2).
const monto = (opts) => rule((raw) => {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (s === null || !/^\d+(\.\d{1,2})?$/.test(s)) {
    return { error: 'El monto debe ser un número positivo con hasta 2 decimales' };
  }
  const n = Number(s);
  if (n <= 0) return { error: 'El monto debe ser mayor a 0' };
  if (n > 99999999.99) return { error: 'El monto es demasiado grande' };
  return { value: n };
}, opts);

function parseFecha(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

// Fecha YYYY-MM-DD real.
const fecha = (label, opts) => rule((raw) => {
  const v = parseFecha(raw);
  return v ? { value: v } : { error: `${label} no es una fecha válida (formato AAAA-MM-DD)` };
}, opts);

// Fecha de nacimiento: válida, desde 1900 y no futura.
const fechaNacimiento = (opts) => rule((raw) => {
  const v = parseFecha(raw);
  if (!v) return { error: 'La fecha de nacimiento no es una fecha válida (formato AAAA-MM-DD)' };
  if (v > hoyISO()) return { error: 'La fecha de nacimiento no puede ser futura' };
  if (v < '1900-01-01') return { error: 'La fecha de nacimiento no es válida' };
  return { value: v };
}, opts);

// Nombre de producto: letras, dígitos y espacios (sin guion/apóstrofe). 2-60.
const NOMBRE_PRODUCTO_RE = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;
const nombreProducto = (label, opts) => rule((raw) => {
  if (typeof raw !== 'string') return { error: `${label} debe ser texto` };
  const v = raw.trim().replace(/\s+/g, ' ');
  if (v.length < 2 || v.length > 60) return { error: `${label} debe tener entre 2 y 60 caracteres` };
  if (!NOMBRE_PRODUCTO_RE.test(v)) return { error: `${label} solo puede contener letras, números y espacios` };
  return { value: v };
}, opts);

// Entero dentro de un rango opcional (stock, cantidades, deltas de ajuste).
const entero = (label, { min, max, ...opts } = {}) => rule((raw) => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n)) return { error: `${label} debe ser un número entero` };
  if (min !== undefined && n < min) return { error: `${label} debe ser mayor o igual a ${min}` };
  if (max !== undefined && n > max) return { error: `${label} debe ser menor o igual a ${max}` };
  return { value: n };
}, opts);

// UUID (los ids de este sistema son uuid, no enteros).
const uuid = (label, opts) => rule((raw) => (
  typeof raw === 'string' && UUID_RE.test(raw) ? { value: raw.toLowerCase() } : { error: `${label} no es válido` }
), opts);

const enumOf = (label, list, opts) => rule((raw) => (
  list.includes(raw) ? { value: raw } : { error: `${label} inválido. Valores permitidos: ${list.join(', ')}` }
), opts);

// Texto libre con largo máximo.
const texto = (label, { max, ...opts } = {}) => rule((raw) => {
  if (typeof raw !== 'string') return { error: `${label} debe ser texto` };
  const v = raw.trim();
  if (v.length > max) return { error: `${label} no puede superar los ${max} caracteres` };
  return { value: v };
}, opts);

// URL http(s).
const url = (label, opts) => rule((raw) => {
  if (typeof raw !== 'string' || raw.length > 500) return { error: `${label} no es una URL válida` };
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return { value: u.toString() };
  } catch {
    return { error: `${label} no es una URL válida` };
  }
}, opts);

// Lista de strings sin repetidos (p. ej. permisos).
const listaStrings = (label, opts) => rule((raw) => {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    return { error: `${label} debe ser una lista de textos` };
  }
  return { value: [...new Set(raw.map((x) => x.trim()).filter(Boolean))] };
}, opts);

function validate(body, schema, { partial = false } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const values = {};
  const errors = {};
  for (const [key, check] of Object.entries(schema)) {
    const res = check(src[key], { partial });
    if (res === SKIP) continue;
    if (res.error) errors[key] = res.error;
    else values[key] = res.value;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

function sendValidationError(res, errors, message = 'Hay campos con errores. Revisá los datos ingresados.') {
  return res.status(400).json({ message, errors });
}

function sendConflict(res, message, errors) {
  return res.status(409).json({ message, ...(errors ? { errors } : {}) });
}

// router.param('id', uuidParam) -> 400 si el parámetro de ruta no es un uuid.
function uuidParam(req, res, next, value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return sendValidationError(res, { [name]: 'El id no es válido' }, 'Id inválido');
  }
  next();
}

module.exports = {
  nombre, dni, telefono, email, password, monto, fecha, fechaNacimiento, uuid, enumOf, texto, url,
  listaStrings, nombreProducto, entero, validate, sendValidationError, sendConflict, uuidParam,
};
