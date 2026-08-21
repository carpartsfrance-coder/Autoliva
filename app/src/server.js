require('dotenv').config();

const mongoose = require('mongoose');
const app = require('./app');
const { startScheduler } = require('./jobs/scheduler');

const port = process.env.PORT || 3000;

/* ── Pourquoi le serveur écoute AVANT de toucher la base (panne du 21/08/2026)
 *
 * Auparavant, `app.listen()` n'était appelé qu'APRÈS `mongoose.connect()` et
 * trois migrations. Tant que la base n'avait pas répondu, le port restait
 * fermé : aucune réponse, pas même sur /robots.txt ou les fichiers statiques.
 *
 * Render interprète un port fermé comme une instance morte et redémarre. Le
 * redémarrage relance un démarrage qui attend la base… qui est lente parce que
 * le site est sous charge. La panne devient auto-entretenue : c'est
 * exactement la boucle « ==> Instance restarted » observée dans les logs.
 *
 * Désormais le processus écoute immédiatement. La base se connecte en tâche de
 * fond, avec des tentatives successives. Une base lente dégrade le site ; elle
 * ne le tue plus. Les routes qui en ont besoin testent déjà
 * `mongoose.connection.readyState` — ce chemin existait, il n'était simplement
 * jamais atteint.
 */

/* Bornes explicites : sans elles, une sélection de serveur peut attendre
   30 secondes par défaut, et une socket bloquée n'est jamais recyclée. */
const OPTIONS_MONGO = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
};

const RECONNEXION_DELAI_MS = 5000;
const RECONNEXION_DELAI_MAX_MS = 60000;

async function appliquerMigrations() {
  /* Chacune est protégée par un marqueur en base : après le premier passage,
     elles coûtent un findOne. Elles restent volontairement hors du chemin
     d'écoute — une migration lente ne doit plus retarder l'ouverture du port. */
  const { applyVatRecoverableParts } = require('./migrations/applyVatRecoverableParts');
  await applyVatRecoverableParts(mongoose.connection);
  const { seedInfoBlocks } = require('./migrations/seedInfoBlocks');
  await seedInfoBlocks(mongoose.connection);
  const { updateInfoBlocksContent } = require('./migrations/updateInfoBlocksContent');
  await updateInfoBlocksContent(mongoose.connection);
}

async function connecterBase(mongoUri, delai = RECONNEXION_DELAI_MS) {
  try {
    await mongoose.connect(mongoUri, OPTIONS_MONGO);
    console.log('MongoDB connectée');
    await appliquerMigrations();
    startScheduler();
  } catch (err) {
    /* On réessaie indéfiniment, avec un délai qui s'allonge. Abandonner
       laisserait un site debout mais définitivement sans base — le pire des
       deux mondes, et c'est ce que faisait le `catch` précédent. */
    console.error('Erreur de connexion MongoDB :', err.message,
      '— nouvelle tentative dans', Math.round(delai / 1000), 's');
    setTimeout(
      () => connecterBase(mongoUri, Math.min(delai * 2, RECONNEXION_DELAI_MAX_MS)),
      delai
    ).unref();
  }
}

function start() {
  app.listen(port, () => {
    console.log(`Serveur démarré : http://localhost:${port}`);
  });

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn('MONGODB_URI non défini : démarrage sans base de données');
    return;
  }
  connecterBase(mongoUri);
}

start();
