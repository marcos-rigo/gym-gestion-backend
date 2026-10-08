const { Router } = require('express');
const { uuidParam } = require('../utils/validators');
const auth = require('../middlewares/auth');
const { requireDueno } = auth;
const { getAll, create, update, toggleActivo, remove } = require('../controllers/usuarioController');

const router = Router();
router.param('id', uuidParam);
router.use(auth, requireDueno);

router.get('/', getAll);
router.post('/', create);
router.put('/:id', update);
router.patch('/:id/toggle-activo', toggleActivo);
router.delete('/:id', remove);

module.exports = router;
