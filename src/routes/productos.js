const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const {
  getAll, getById, create, update, toggleActivo, remove, ajustarStock,
} = require('../controllers/productoController');

const router = Router();
router.param('id', uuidParam);
router.use(auth, cargarRol);

router.get('/', checkPermiso('productos_ver'), getAll);
router.get('/:id', checkPermiso('productos_ver'), getById);
router.post('/', checkPermiso('productos_crear'), create);
router.put('/:id', checkPermiso('productos_editar'), update);
router.patch('/:id/toggle-activo', checkPermiso('productos_editar'), toggleActivo);
router.patch('/:id/stock', checkPermiso('productos_editar'), ajustarStock);
router.delete('/:id', checkPermiso('productos_eliminar'), remove);

module.exports = router;
