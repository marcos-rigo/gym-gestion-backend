const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { cargarRol } = auth;
const checkPermiso = require('../middlewares/checkPermiso');
const { getAll, getPermisosDisponibles, create, update, remove } = require('../controllers/rolController');

const router = Router();
router.param('id', uuidParam);
router.use(auth, cargarRol);

router.get('/',            checkPermiso('roles_ver'),    getAll);
router.get('/permisos',    checkPermiso('roles_ver'),    getPermisosDisponibles);
router.post('/',           checkPermiso('roles_crear'),  create);
router.put('/:id',         checkPermiso('roles_editar'), update);
router.delete('/:id',      checkPermiso('roles_eliminar'), remove);

module.exports = router;
