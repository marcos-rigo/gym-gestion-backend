const { Router } = require('express');
const multer = require('multer');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { subirFoto } = require('../lib/supabaseStorage');

const MIMES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!MIMES_PERMITIDOS.includes(file.mimetype)) {
      const err = new Error('Formato de imagen no permitido. Usá JPG, PNG o WEBP.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});
const router = Router();

// La foto se sube al crear/editar un cliente: exige alguno de esos permisos.
router.post('/foto', auth, cargarRol, checkPermiso('clientes_crear', 'clientes_editar'), upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No se envió ninguna imagen' });
    const url = await subirFoto(req.file.buffer, req.file.originalname || 'foto.jpg', req.file.mimetype);
    return res.json({ url });
  } catch (err) {
    console.error('upload.foto error:', err);
    return res.status(500).json({ message: 'Error al subir la imagen' });
  }
});

module.exports = router;
