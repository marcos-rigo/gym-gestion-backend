const { Router } = require('express');
const multer = require('multer');
const { subirFoto } = require('../lib/supabaseStorage');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const router = Router();

router.post('/foto', upload.single('foto'), async (req, res) => {
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
