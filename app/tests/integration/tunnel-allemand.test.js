/**
 * Le parcours d'achat allemand servi par la VRAIE application (09/2026).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production).
 *
 * Ce qu'on verrouille :
 *   - le port annoncé sur la fiche /de est celui que le paiement encaisse vers
 *     l'Allemagne, y compris quand la classe d'expédition est posée sur la
 *     CATÉGORIE (la fiche cherchait la classe avec le nom allemand « Getriebe »
 *     et retombait sur la classe par défaut, plus basse) ;
 *   - le panier estime ce même port pour un visiteur allemand ;
 *   - la langue du tunnel survit à l'espace compte et à la connexion
 *     (req.session.regenerate() la perdait) ;
 *   - le choix explicite ?lang=fr permet d'en sortir.
 *
 * Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions en mémoire),
 * serveur sur un port éphémère, base en mémoire détruite à la fin.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
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

const FIXTURE = require('../fixtures/fiches-produit-prod.json');

/* Boîte DEK : catégorie « Boîtes de vitesses », AUCUNE classe sur la fiche,
   traduite en allemand. C'est exactement le cas du défaut. */
const DEK = FIXTURE.produits.find((p) => p.sku.startsWith('DEK-'));

const UA_NAVIGATEUR = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMAIL = 'kunde-de@example.com';
const MOT_DE_PASSE = 'passwort-test-123';

function versMongo(p) {
  const doc = { ...p };
  delete doc._role;
  doc._id = new mongoose.Types.ObjectId(p._id);
  if (doc.localizations && doc.localizations.de) {
    doc.localizations = { de: { ...doc.localizations.de } };
    if (doc.localizations.de.translatedAt) doc.localizations.de.translatedAt = new Date(doc.localizations.de.translatedAt);
  }
  return doc;
}

function texte(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const langueHtml = (html) => (String(html).match(/<html[^>]*\blang="([a-z]+)"/) || [])[1];
const euros = (cents) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);

/** Un navigateur minimal : garde le cookie de session entre les requêtes. */
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

test('tunnel allemand — port, langue et compte (application réelle)', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  const classeDefaut = new mongoose.Types.ObjectId();
  const classePalette = new mongoose.Types.ObjectId();
  await db.collection('shippingclasses').insertMany([
    { _id: classeDefaut, name: 'Petit colis', slug: 'petit-colis', isActive: true, isDefault: true, domicilePriceCents: 1290, zonePricesCents: { metropole: 1290, europe: 2490 } },
    { _id: classePalette, name: 'Palette', slug: 'palette', isActive: true, isDefault: false, domicilePriceCents: 4990, zonePricesCents: { metropole: 4990, europe: 12900 } },
  ]);
  await db.collection('categories').insertOne({
    name: DEK.category, slug: 'boites-de-vitesses', isActive: true, shippingClassId: classePalette,
    localizations: { de: { name: 'Getriebe', slug: 'getriebe' } },
  });
  const produit = versMongo(DEK);
  delete produit.shippingClassId;
  await db.collection('products').insertOne(produit);

  const salt = crypto.randomBytes(16).toString('hex');
  await db.collection('users').insertOne({
    accountType: 'particulier', firstName: 'Max', lastName: 'Mustermann', email: EMAIL,
    passwordSalt: salt, passwordHash: crypto.pbkdf2Sync(MOT_DE_PASSE, salt, 120000, 32, 'sha256').toString('hex'),
    addresses: [], createdAt: new Date(), updatedAt: new Date(),
  });

  const app = require('../../src/app');
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const cheminDe = `/de/produits/${encodeURIComponent(DEK.localizations.de.slug)}-${DEK._id}`;
  const { getShippingMethods } = require('../../src/services/shippingPricing');
  const Product = require('../../src/models/Product');

  await t.test('fiche /de : le port annoncé est celui du paiement vers l’Allemagne (classe posée sur la catégorie)', async () => {
    const r = await navigateur(base)(cheminDe);
    assert.equal(r.status, 200, `fiche allemande : ${r.status} ${r.location || ''}`);
    const lu = texte(r.html).match(/zzgl\. ([\d\s ,.]+) € Versand nach Deutschland/);
    assert.ok(lu, 'la ligne « zzgl. … € Versand nach Deutschland » manque');

    /* Le montant que le paiement encaisse : même fonction, produit tel qu'en
       base (catégorie française), adresse à Berlin. */
    const enBase = await Product.findById(DEK._id).lean();
    const methodes = await getShippingMethods(true, [enBase], { country: 'Allemagne', postalCode: '10115' }, 'de');
    const paiement = methodes.find((m) => m.id === 'domicile').priceCents;
    assert.equal(paiement, 12900, 'le paiement doit appliquer la classe de la catégorie');
    assert.equal(lu[1].replace(/\s/g, ' ').trim(), euros(paiement), 'la fiche annonce un autre port que le paiement');
  });

  await t.test('fiche /de : délai et garantie cohérents', async () => {
    const r = await navigateur(base)(cheminDe);
    const lisible = texte(r.html);
    /* « 24-72 Std. » n'est pas une expédition sous 24/48 h : pas de « 2–4 Werktage ». */
    assert.ok(!lisible.includes('Zustellung 2–4 Werktage nach Versand'), 'délai de transport promis sur une expédition sous 72 h');
    /* Fiche sans option de garantie : une seule durée, partout. */
    assert.ok(lisible.includes('24 Monate auf das Teil'), 'comparatif sans la durée exacte');
    assert.ok(!/Bis zu 24 Monate/.test(lisible), '« Bis zu 24 Monate » sur une fiche à durée unique');
    assert.ok(!lisible.includes('Garantie sur la pièce'), 'texte français en dur dans le comparatif');
  });

  await t.test('panier, compte, connexion : la langue allemande tient jusqu’au bout', async () => {
    const nav = navigateur(base);
    assert.equal((await nav(cheminDe)).status, 200);

    const ajout = await nav(`/panier/ajouter/${DEK._id}`, { method: 'POST', form: { quantity: '1' } });
    assert.equal(ajout.status, 302, 'ajout au panier');

    const panier = await nav('/panier');
    assert.equal(langueHtml(panier.html), 'de', 'panier');
    assert.ok(texte(panier.html).includes(`${euros(12900)} €`), 'le panier doit estimer le port vers l’Allemagne');

    /* Lien « Konto » d'une page /de : /de/compte → /compte → connexion. */
    const compte = await nav('/compte');
    assert.equal(compte.status, 302);
    const connexion = await nav(compte.location.replace(base, ''));
    assert.equal(langueHtml(connexion.html), 'de', '/compte a remis le français');

    const mauvais = await nav('/compte/connexion', { method: 'POST', form: { email: EMAIL, password: 'faux', returnTo: '/panier' } });
    assert.equal(mauvais.status, 401);
    assert.ok(texte(mauvais.html).includes('E-Mail-Adresse oder Passwort ist falsch.'), 'erreur de connexion en français');

    const login = await nav('/compte/connexion', { method: 'POST', form: { email: EMAIL, password: MOT_DE_PASSE, returnTo: '/panier' } });
    assert.equal(login.status, 302, 'connexion');
    assert.equal(login.location, '/panier');

    const apres = await nav('/panier');
    assert.equal(langueHtml(apres.html), 'de', 'la connexion (regenerate) a perdu la langue');
    assert.ok(texte(apres.html).includes('Zur Kasse'));

    /* Sortie explicite vers le français, puis la préférence tient. */
    const fr = await nav('/panier?lang=fr');
    assert.equal(langueHtml(fr.html), 'fr', '?lang=fr');
    assert.equal(langueHtml((await nav('/panier')).html), 'fr');
  });
});
