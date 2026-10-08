const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

function assertEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno requeridas: ${missing.join(', ')}`);
  }
}

// CORS_ORIGIN: lista separada por comas. Fallback a FRONTEND_URL (legacy) y luego a localhost:3000.
function corsOrigins() {
  const raw = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

module.exports = { assertEnv, corsOrigins };
