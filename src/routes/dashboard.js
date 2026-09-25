const { Router } = require('express');
const auth = require('../middlewares/auth');
const { getStats } = require('../controllers/dashboardController');

const router = Router();
router.get('/stats', auth, getStats);

module.exports = router;
