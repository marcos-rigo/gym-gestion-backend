const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { create, anular, findAll, getById, getReportes } = require('../controllers/ventaController');

const router = Router();
router.param('id', uuidParam);
router.use(auth, cargarRol);

router.get('/', checkPermiso('ventas_ver'), findAll);
router.get('/reportes', checkPermiso('ventas_ver'), getReportes);
router.post('/', checkPermiso('ventas_registrar'), create);
router.get('/:id', checkPermiso('ventas_ver'), getById);
router.post('/:id/anular', checkPermiso('ventas_anular'), anular);

module.exports = router;
