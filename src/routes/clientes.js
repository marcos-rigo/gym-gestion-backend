const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { getAll, getById, create, update, remove, getMorosos, getPorVencer } = require('../controllers/clienteController');

const router = Router();
router.param('id', uuidParam);
router.use(auth, cargarRol);

router.get('/',             checkPermiso('clientes_ver'),      getAll);
router.get('/morosos',      checkPermiso('facturacion_ver'),   getMorosos);
router.get('/por-vencer',   checkPermiso('facturacion_ver'),   getPorVencer);
router.get('/:id',    checkPermiso('clientes_ver'),      getById);
router.post('/',      checkPermiso('clientes_crear'),    create);
router.put('/:id',    checkPermiso('clientes_editar'),   update);
router.delete('/:id', checkPermiso('clientes_eliminar'), remove);

module.exports = router;
