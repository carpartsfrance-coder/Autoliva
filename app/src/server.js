require('dotenv').config();

const mongoose = require('mongoose');
const app = require('./app');
const { startScheduler } = require('./jobs/scheduler');

const port = process.env.PORT || 3000;

async function start() {
  const mongoUri = process.env.MONGODB_URI;

  if (mongoUri) {
    try {
      await mongoose.connect(mongoUri);
      console.log('MongoDB connectée');
      startScheduler();
    } catch (err) {
      console.error('Erreur de connexion MongoDB :', err.message);
    }
  } else {
    console.warn('MONGODB_URI non défini : démarrage sans base de données');
  }

  app.listen(port, () => {
    console.log(`Serveur démarré : http://localhost:${port}`);
  });
}

start();
