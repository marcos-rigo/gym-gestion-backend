const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { create, findByCliente, getStats } = require('../controllers/pagoController');

const router = Router();
router.param('clienteId', uuidParam);
router.use(auth, cargarRol);

router.post('/', checkPermiso('facturacion_cobrar'), create);
router.get('/cliente/:clienteId', checkPermiso('facturacion_ver'), findByCliente);
router.get('/stats', checkPermiso('facturacion_ver'), getStats);

module.exports = router;
