const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const {
  crearMovimiento, listarMovimientos, anularMovimiento, getApertura, putApertura, getCierre,
  crearCierre, listarCierres, getEstadoTurno,
} = require('../controllers/cajaController');

const router = Router();
router.param('id', uuidParam);
router.use(auth, cargarRol);

router.get('/movimientos', checkPermiso('caja_ver'), listarMovimientos);
router.post('/movimientos', checkPermiso('caja_movimientos'), crearMovimiento);
router.post('/movimientos/:id/anular', checkPermiso('caja_movimientos'), anularMovimiento);
router.get('/apertura', checkPermiso('caja_ver'), getApertura);
router.put('/apertura', checkPermiso('caja_movimientos'), putApertura);
router.get('/cierre', checkPermiso('caja_ver'), getCierre);
router.get('/cierres', checkPermiso('caja_ver'), listarCierres);
router.get('/cierres/estado', checkPermiso('caja_ver'), getEstadoTurno);
router.post('/cierres', checkPermiso('caja_movimientos'), crearCierre);

module.exports = router;
