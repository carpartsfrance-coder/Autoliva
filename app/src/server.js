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
      // Migration one-shot (garde-fou par marqueur) : TVA récupérable sur les
      // mécatroniques/TCU, ponts/différentiels, boîtes de transfert.
      const { applyVatRecoverableParts } = require('./migrations/applyVatRecoverableParts');
      await applyVatRecoverableParts(mongoose.connection);
      // Seed one-shot des blocs d'information « Conditions » de départ.
      const { seedInfoBlocks } = require('./migrations/seedInfoBlocks');
      await seedInfoBlocks(mongoose.connection);
      // Remplace le contenu placeholder des blocs seedés par le vrai contenu.
      const { updateInfoBlocksContent } = require('./migrations/updateInfoBlocksContent');
      await updateInfoBlocksContent(mongoose.connection);
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
