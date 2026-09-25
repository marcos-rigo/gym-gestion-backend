const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: WebSocket } }
);

async function subirFoto(buffer, nombreArchivo, mimetype) {
  const path = `${Date.now()}-${nombreArchivo}`;
  const { error } = await supabase.storage
    .from('fotos-clientes')
    .upload(path, buffer, { contentType: mimetype });
  if (error) throw error;

  const { data } = supabase.storage.from('fotos-clientes').getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { subirFoto };
