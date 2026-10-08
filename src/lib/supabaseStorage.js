const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: WebSocket } }
);

const EXT_POR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// El nombre original del cliente nunca se usa en el path: se genera uno propio.
async function subirFoto(buffer, nombreArchivo, mimetype) {
  const ext = EXT_POR_MIME[mimetype] ?? 'jpg';
  const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from('fotos-clientes')
    .upload(path, buffer, { contentType: mimetype });
  if (error) throw error;

  const { data } = supabase.storage.from('fotos-clientes').getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { subirFoto };
