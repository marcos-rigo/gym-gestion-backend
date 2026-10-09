const { Router } = require('express');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { recaudacionPdf } = require('../controllers/reporteController');

const router = Router();
router.use(auth, cargarRol);

router.get('/recaudacion-pdf', checkPermiso('caja_ver'), recaudacionPdf);

module.exports = router;
