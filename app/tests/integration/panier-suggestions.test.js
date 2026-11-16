/**
 * « Complétez votre commande » dans le panier (16/11/2026).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production).
 *
 * La section proposait les 4 derniers produits créés, quels qu'ils soient : un
 * moteur Nissan à 6 672 € sous une mécatronique DQ200. Elle ne montre plus que
 * les accessoires liés aux pièces du panier (champ « accessoires » de la
 * fiche), publiés et en stock — et disparaît s'il n'y en a aucun.
 *
 * Verrouille aussi le bouton principal du panier : la commande SANS compte
 * (avant, en français, il menait à la page de connexion).
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI; // sessions en mémoire, jamais de base externe
delete process.env.SCALAPAY_ENABLED;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const UA_NAVIGATEUR = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function navigateur(base) {
  let cookie = '';
  return async function requete(chemin, { method = 'GET', form } = {}) {
    const headers = { 'user-agent': UA_NAVIGATEUR, accept: 'text/html' };
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const r = await fetch(base + chemin, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      if (c.startsWith('carpartsfrance.sid=')) cookie = c.split(';')[0];
    }
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
}

function produit(nom, extra = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: nom,
    slug: nom.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    sku: `T-${nom.slice(0, 6).toUpperCase().replace(/\s/g, '')}`,
    category: 'Mécatroniques & calculateurs',
    priceCents: 10000,
    inStock: true,
    isPublished: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

test('panier — suggestions = accessoires liés, commande sans compte en premier', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  const huile = produit('Huile DSG test');
  const outil = produit('Outil test brouillon', { isPublished: false });
  const kit = produit('Kit test hors stock', { inStock: false });
  const moteur = produit('Moteur sans rapport test', { category: 'Moteurs', priceCents: 667200, createdAt: new Date(Date.now() + 1000) });
  const meca = produit('Mecatronique principale test', { accessories: [huile._id, outil._id, kit._id] });
  const seule = produit('Piece sans accessoire test');
  await db.collection('products').insertMany([huile, outil, kit, moteur, meca, seule]);
  await db.collection('categories').insertMany([
    { name: 'Mécatroniques & calculateurs', slug: 'mecatroniques-calculateurs', isActive: true },
    { name: 'Moteurs', slug: 'moteurs', isActive: true },
  ]);

  const app = require('../../src/app');
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  await t.test('pièce avec accessoires : seuls les accessoires publiés et en stock sont proposés', async () => {
    const nav = navigateur(base);
    assert.equal((await nav(`/panier/ajouter/${meca._id}`, { method: 'POST', form: { quantity: '1' } })).status, 302);
    const { html } = await nav('/panier');
    assert.ok(html.includes('Huile DSG test'), 'l’accessoire lié doit être proposé');
    assert.ok(!html.includes('Outil test brouillon'), 'un brouillon ne doit pas être proposé');
    assert.ok(!html.includes('Kit test hors stock'), 'une pièce hors stock ne doit pas être proposée');
    assert.ok(!html.includes('Moteur sans rapport test'), 'le dernier produit créé ne doit plus être proposé au hasard');
  });

  await t.test('pièce sans accessoire : la section n’est pas affichée', async () => {
    const nav = navigateur(base);
    await nav(`/panier/ajouter/${seule._id}`, { method: 'POST', form: { quantity: '1' } });
    const { html } = await nav('/panier');
    assert.ok(html.includes('Piece sans accessoire test'), 'la pièce doit être dans le panier');
    assert.ok(!html.includes('Complétez votre commande'), 'section vide affichée');
    assert.ok(!html.includes('Moteur sans rapport test'));
  });

  await t.test('visiteur sans compte : le bouton principal mène à la commande, pas à la connexion', async () => {
    const nav = navigateur(base);
    await nav(`/panier/ajouter/${seule._id}`, { method: 'POST', form: { quantity: '1' } });
    const { html } = await nav('/panier');
    const bouton = html.match(/<a class="w-full bg-primary[^"]*" href="([^"]+)">\s*Valider ma commande/);
    assert.ok(bouton, 'bouton « Valider ma commande » introuvable');
    assert.equal(bouton[1], '/commande/livraison?guest=1');
    assert.ok(html.includes('Déjà un compte ? Se connecter'));
  });
});
