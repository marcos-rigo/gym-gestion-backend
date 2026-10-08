const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { create, anular, findAll, findByCliente, getStats, getCierreCaja } = require('../controllers/pagoController');

const router = Router();
router.param('id', uuidParam);
router.param('clienteId', uuidParam);
router.use(auth, cargarRol);

router.get('/', checkPermiso('facturacion_ver'), findAll);
router.post('/', checkPermiso('facturacion_cobrar'), create);
router.post('/:id/anular', checkPermiso('facturacion_anular'), anular);
router.get('/cliente/:clienteId', checkPermiso('facturacion_ver'), findByCliente);
router.get('/stats', checkPermiso('facturacion_ver'), getStats);
router.get('/cierre-caja', checkPermiso('facturacion_ver'), getCierreCaja);

module.exports = router;
