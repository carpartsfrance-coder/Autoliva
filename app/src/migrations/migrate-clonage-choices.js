#!/usr/bin/env node

/**
 * Migration : ajoute triggersCloning = true sur les choix d'options "clonage"
 * dans les ProductOptionTemplate et les Product.
 *
 * Cible les options dont le key contient "clonage" et met triggersCloning = true
 * sur les choix dont le key contient "oui".
 *
 * Usage : node src/migrations/migrate-clonage-choices.js
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

    const db = mongoose.connection.db;

    // 1. ProductOptionTemplate : options avec key contenant "clonage"
    const templateResult = await db
      .collection('productoptiontemplates')
      .updateMany(
        {
          key: { $regex: /clonage/i },
          'choices.key': { $regex: /oui/i },
        },
        { $set: { 'choices.$[c].triggersCloning': true } },
        { arrayFilters: [{ 'c.key': { $regex: /oui/i } }] }
      );

    console.log(`Templates : ${templateResult.modifiedCount} template(s) mis à jour.`);

    // 2. Product : options avec key contenant "clonage"
    const productResult = await db
      .collection('products')
      .updateMany(
        {
          'options.key': { $regex: /clonage/i },
          'options.choices.key': { $regex: /oui/i },
        },
        { $set: { 'options.$[o].choices.$[c].triggersCloning': true } },
        {
          arrayFilters: [
            { 'o.key': { $regex: /clonage/i } },
            { 'c.key': { $regex: /oui/i } },
          ],
        }
      );

    console.log(`Produits : ${productResult.modifiedCount} produit(s) mis à jour.`);

    console.log('Migration terminée.');
  } catch (err) {
    console.error('Erreur lors de la migration :', err.message || err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Déconnexion de MongoDB.');
    process.exit(0);
  }
})();
