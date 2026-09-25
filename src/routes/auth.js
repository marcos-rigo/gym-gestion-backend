const { Router } = require('express');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const { login, misPermisos } = require('../controllers/authController');

const router = Router();
router.post('/login', login);
router.get('/mis-permisos', auth, cargarRol, misPermisos);

module.exports = router;
