#!/usr/bin/env node

/**
 * Migration : corrige orderType pour les commandes ayant des lignes de consigne.
 *
 * Les commandes avec consigne.lines non vides sont des échanges standard
 * mais avaient orderType = 'standard' (valeur par défaut) car le champ
 * n'était pas défini à la création.
 *
 * Usage : node src/migrations/migrate-ordertype-exchange.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('MONGODB_URI non défini dans l\'environnement. Vérifiez votre fichier .env.');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connecté à MongoDB.');

    const result = await mongoose.connection.db
      .collection('orders')
      .updateMany(
        {
          'consigne.lines.0': { $exists: true },
          $or: [
            { orderType: 'standard' },
            { orderType: { $exists: false } },
          ],
        },
        { $set: { orderType: 'exchange' } }
      );

    console.log(`Migration terminée : ${result.modifiedCount} commande(s) corrigée(s) (standard → exchange).`);
  } catch (err) {
    console.error('Erreur lors de la migration :', err.message || err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Déconnexion de MongoDB.');
    process.exit(0);
  }
})();
