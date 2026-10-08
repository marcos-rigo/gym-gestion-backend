const app = require('./app');
const { testConnection } = require('./src/config/db');

async function start() {
  await testConnection();
  app.listen(process.env.PORT || 3001, () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${process.env.PORT || 3001}`);
  });
}

start();
