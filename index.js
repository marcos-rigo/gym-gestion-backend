require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { testConnection } = require('./src/config/db');
const authRoutes = require('./src/routes/auth');
const clientesRoutes = require('./src/routes/clientes');
const uploadRoutes = require('./src/routes/upload');
const usuariosRoutes = require('./src/routes/usuarios');
const rolesRoutes = require('./src/routes/roles');
const dashboardRoutes = require('./src/routes/dashboard');
const pagosRoutes = require('./src/routes/pagos');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/clientes', clientesRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/pagos', pagosRoutes);

async function start() {
  await testConnection();
  app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
  });
}

start();
