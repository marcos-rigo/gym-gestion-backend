require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { assertEnv, corsOrigins } = require('./src/config/env');

assertEnv();

const authRoutes = require('./src/routes/auth');
const clientesRoutes = require('./src/routes/clientes');
const uploadRoutes = require('./src/routes/upload');
const usuariosRoutes = require('./src/routes/usuarios');
const rolesRoutes = require('./src/routes/roles');
const dashboardRoutes = require('./src/routes/dashboard');
const pagosRoutes = require('./src/routes/pagos');
const productosRoutes = require('./src/routes/productos');
const ventasRoutes = require('./src/routes/ventas');
const cajaRoutes = require('./src/routes/caja');

const app = express();
app.disable('x-powered-by');

app.use(cors({ origin: corsOrigins(), credentials: true }));
app.use(express.json({ limit: '100kb' }));

app.use('/api/auth', authRoutes);
app.use('/api/clientes', clientesRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/pagos', pagosRoutes);
app.use('/api/productos', productosRoutes);
app.use('/api/ventas', ventasRoutes);
app.use('/api/caja', cajaRoutes);

app.use((req, res) => res.status(404).json({ message: 'Ruta no encontrada' }));

// Errores que no atrapa ningún controller: JSON malformado, multer, etc. Siempre responden JSON.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'El cuerpo de la petición no es un JSON válido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ message: 'La petición es demasiado grande' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'La imagen supera el máximo de 5 MB' });
  if (err.name === 'MulterError') return res.status(400).json({ message: 'Error al procesar el archivo' });
  if (err.status === 400) return res.status(400).json({ message: err.message });
  console.error('unhandled error:', err);
  return res.status(500).json({ message: 'Error interno del servidor' });
});

module.exports = app;
