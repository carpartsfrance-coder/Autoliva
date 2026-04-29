#!/usr/bin/env node

/**
 * Migration : renomme le rôle 'staff' en 'employe' pour tous les AdminUser.
 *
 * Usage : node src/migrations/migrate-staff-to-employe.js
 *
 * Charge les variables d'environnement via dotenv et se connecte à MongoDB
 * avec l'URI définie dans MONGODB_URI.
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
      .collection('adminusers')
      .updateMany({ role: 'staff' }, { $set: { role: 'employe' } });

    console.log(`Migration terminée : ${result.modifiedCount} document(s) mis à jour (staff → employe).`);
  } catch (err) {
    console.error('Erreur lors de la migration :', err.message || err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Déconnexion de MongoDB.');
    process.exit(0);
  }
})();
