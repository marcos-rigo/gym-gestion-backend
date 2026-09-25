const { Router } = require('express');
const auth = require('../middlewares/auth');
const { requireDueno } = auth;
const { getAll, create, update, toggleActivo } = require('../controllers/usuarioController');

const router = Router();
router.use(auth, requireDueno);

router.get('/', getAll);
router.post('/', create);
router.put('/:id', update);
router.patch('/:id/toggle-activo', toggleActivo);

module.exports = router;
