const { Router } = require('express');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { getStats } = require('../controllers/dashboardController');

const router = Router();
router.get('/stats', auth, cargarRol, checkPermiso('estadisticas_ver'), getStats);

module.exports = router;
