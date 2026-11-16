/**
 * Recherche : plaque d'immatriculation et référence introuvable (16/11/2026).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe).
 *
 * - « AB-123-CD » : plus de recherche texte (11 221 fiches en production, des
 *   turbos Fiat « Ab » en tête) ; on propose de faire identifier la pièce,
 *   plaque préremplie dans le devis.
 * - Référence introuvable : plus seulement « Aucune pièce trouvée » ; un lien
 *   vers le devis, référence préremplie.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
process.env.ATLAS_SEARCH = 'off'; // pas d'Atlas en local : le repli JS suffit ici
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

test('recherche — plaque et référence introuvable', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  await mongoose.connection.db.collection('products').insertMany([
    { name: 'Turbo reconditionné Fiat Grande Punto Ab Multiair', sku: 'T-AB-1', category: 'Turbos', priceCents: 50000, inStock: true, isPublished: true, createdAt: new Date() },
    { name: 'Mécatronique DSG7 DQ200 reconditionnée', sku: '0AM 325 025', category: 'Mécatroniques & calculateurs', priceCents: 129000, inStock: true, isPublished: true, createdAt: new Date() },
  ]);

  const app = require('../../src/app');
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  const get = async (chemin) => (await fetch(base + chemin, { headers: { accept: 'text/html' } })).text();

  t.after(async () => {
    delete process.env.ATLAS_SEARCH;
    await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  await t.test('plaque « AB-123-CD » : pas de résultats au hasard, lien d’identification', async () => {
    for (const saisie of ['AB-123-CD', 'ab 123 cd', 'AB123CD']) {
      const html = await get(`/produits?q=${encodeURIComponent(saisie)}`);
      assert.ok(html.includes('data-recherche-plaque'), `${saisie} : bloc plaque absent`);
      assert.ok(!html.includes('Grande Punto'), `${saisie} : une fiche a été proposée sur une plaque`);
      assert.ok(html.includes(`/devis?plate=${encodeURIComponent(saisie)}`), `${saisie} : lien devis absent`);
    }
  });

  await t.test('référence introuvable : lien « Faire rechercher cette pièce » vers le devis', async () => {
    const html = await get('/produits?q=ZZZNONREF2026');
    assert.ok(html.includes('data-recherche-vide'));
    assert.ok(html.includes('/devis?partRef=ZZZNONREF2026'));
    assert.ok(html.includes('/rechercher?q=ZZZNONREF2026'));
  });

  await t.test('une saisie est échappée dans le message', async () => {
    const html = await get(`/produits?q=${encodeURIComponent('<b>x9z</b>')}`);
    assert.ok(!html.includes('<b>x9z</b>'), 'saisie non échappée');
  });

  await t.test('une vraie référence trouve toujours sa fiche', async () => {
    const html = await get('/produits?q=0AM325025');
    assert.ok(html.includes('Mécatronique DSG7 DQ200'));
    assert.ok(!html.includes('data-recherche-vide'));
  });
});
