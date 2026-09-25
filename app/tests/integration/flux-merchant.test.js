/**
 * Flux Google Merchant servis par la VRAIE application — audit du 25/09/2026.
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Aucun envoi possible : clés vides, sessions en mémoire, port
 * éphémère.
 *
 * Ce qui ne se vérifie qu'avec une base :
 *   - le port de chaque article est EXACTEMENT celui que le panier facturerait
 *     pour la fiche seule (getShippingMethods), en France comme en Allemagne ;
 *   - les délais de préparation et de transport suivent la classe de la pièce ;
 *   - un tarif modifié (classe ou catégorie) relance la construction du flux.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
delete process.env.SCALAPAY_ENABLED;
delete process.env.SHOW_PRODUCT_DESCRIPTION;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const FIXTURE = require('../fixtures/fiches-produit-prod.json');
const { verifierXmlBienForme } = require('../fixtures/xml-bien-forme');

const oid = () => new mongoose.Types.ObjectId();

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

/** Articles d'un flux : { id → XML de l'article }. */
function articles(xml) {
  const out = new Map();
  for (const bloc of xml.split('<item>').slice(1)) {
    const id = (bloc.match(/<g:id>([^<]+)<\/g:id>/) || [])[1];
    out.set(id, bloc.slice(0, bloc.indexOf('</item>')));
  }
  return out;
}

const champ = (bloc, nom) => (bloc.match(new RegExp(`<g:${nom}>([^<]*)</g:${nom}>`)) || [])[1];
const portDuFlux = (bloc) => (bloc.match(/<g:shipping>[\s\S]*?<g:price>([^<]+)<\/g:price>/) || [])[1];
const euros = (cents) => `${(cents / 100).toFixed(2)} EUR`;

test('flux Merchant : port exact du panier, délais, cache des tarifs', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  const classeDefaut = oid();
  const classeBoite = oid();
  const classePalette = oid();
  const classeEnveloppe = oid();
  await db.collection('shippingclasses').insertMany([
    { _id: classeDefaut, name: 'Petit colis', slug: 'petit-colis', isActive: true, isDefault: true, domicilePriceCents: 1290, zonePricesCents: { metropole: 1290, europe: 2490 } },
    /* Pas de prix Europe : le panier retombe sur le prix métropole. */
    { _id: classeBoite, name: 'Boîte de vitesses Échange standard', slug: 'boite-echange-standard', isActive: true, isDefault: false, domicilePriceCents: 8900, zonePricesCents: { metropole: 8900, europe: null } },
    { _id: classePalette, name: 'Palette', slug: 'palette', isActive: true, isDefault: false, domicilePriceCents: 14900, zonePricesCents: { metropole: 14900, europe: 29900 } },
    /* Classe de fiche MOINS chère que la classe par défaut : le panier prend le maximum. */
    { _id: classeEnveloppe, name: 'Enveloppe', slug: 'enveloppe', isActive: true, isDefault: false, domicilePriceCents: 490, zonePricesCents: { metropole: 490 } },
  ]);
  const categories = [...new Set(FIXTURE.produits.map((p) => p.category))];
  await db.collection('categories').insertMany([
    ...categories.map((name) => ({
      name,
      slug: name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      isActive: true,
      shippingClassId: name === 'Boîtes de vitesses' ? classeBoite : (name === 'Moteurs' ? classePalette : null),
    })),
    /* Sous-catégorie sans classe : hérite de sa catégorie principale. */
    { name: 'Transmission', slug: 'transmission', isActive: true, shippingClassId: classePalette },
    { name: 'Transmission > Pont / Différentiel', slug: 'transmission-pont', isActive: true, shippingClassId: null },
  ]);

  const produits = FIXTURE.produits.map(versMongo);
  const pont = {
    ...versMongo({ ...FIXTURE.produits.find((p) => p.sku.startsWith('DEK-')), _id: oid().toHexString() }),
    name: 'Pont arrière reconditionné BMW X5 E70 3.64 — 33107566245',
    slug: 'pont-arriere-bmw-x5-e70-3-64',
    sku: 'PONT-TEST-1',
    category: 'Transmission > Pont / Différentiel',
    imageUrl: `/media/${oid().toHexString()}`,
    galleryUrls: [],
    localizations: undefined,
  };
  const phare = {
    ...pont,
    _id: oid(),
    name: 'Phare avant LED BMW Série 5 G30 reconditionné',
    slug: 'phare-avant-bmw-g30',
    sku: 'WC-TEST-2',
    category: 'Carrosserie / Éclairage > Phares / Feux',
    shippingClassId: classeEnveloppe,
    imageUrl: `/media/${oid().toHexString()}`,
  };
  await db.collection('products').insertMany([...produits, pont, phare]);

  const app = require('../../src/app');
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });
  const get = async (chemin) => {
    const r = await fetch(base + chemin);
    return { status: r.status, type: r.headers.get('content-type'), corps: await r.text() };
  };

  const { getShippingMethods, chargerTarifsPort } = require('../../src/services/shippingPricing');
  const Product = require('../../src/models/Product');
  const ShippingClass = require('../../src/models/ShippingClass');
  const Category = require('../../src/models/Category');
  const feedFr = require('../../src/routes/google-merchant-feed');
  const feedDe = require('../../src/routes/google-merchant-feed-de');
  const portPanier = async (p, adresse, lang) => (await getShippingMethods(true, [p], adresse, lang)).find((m) => m.id === 'domicile').priceCents;

  await t.test('les tarifs chargés une fois donnent le port du panier, fiche par fiche', async () => {
    const tarifs = await chargerTarifsPort();
    const enBase = await Product.find({}).lean();
    assert.ok(enBase.length >= 12);
    for (const p of enBase) {
      assert.equal(tarifs.portDomicileCents(p, 'metropole'), await portPanier(p, undefined, 'fr'), `${p.sku} (France)`);
      assert.equal(tarifs.portDomicileCents(p, 'europe'), await portPanier(p, { country: 'Allemagne', postalCode: '10115' }, 'de'), `${p.sku} (Allemagne)`);
    }
    assert.equal(tarifs.portDomicileCents(phare, 'metropole'), 1290, 'classe de fiche moins chère que le défaut : le maximum');
    assert.equal(tarifs.portDomicileCents(pont, 'metropole'), 14900, 'sous-catégorie : classe de la catégorie principale');
  });

  await t.test('flux français : chaque article porte le port du panier et les délais des CGV', async () => {
    feedFr._invalidateCache();
    const r = await get('/google-merchant-feed.xml');
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/xml/);
    verifierXmlBienForme(r.corps);
    const items = articles(r.corps);
    assert.ok(items.size >= 4, `${items.size} articles`);
    for (const [id, bloc] of items) {
      const p = await Product.findById(id).lean();
      assert.equal(portDuFlux(bloc), euros(await portPanier(p, undefined, 'fr')), `${p.sku} : port du flux ≠ port du panier`);
      assert.match(bloc, /<g:shipping>\s*<g:country>FR<\/g:country>\s*<g:service>Livraison à domicile<\/g:service>/);
      for (const requis of ['title', 'link', 'image_link', 'availability', 'price', 'condition', 'google_product_category']) {
        assert.ok(champ(bloc, requis), `${p.sku} : ${requis} manquant`);
      }
      assert.ok((champ(bloc, 'brand') && champ(bloc, 'mpn')) || champ(bloc, 'identifier_exists') === 'no', `${p.sku} : ni marque + MPN, ni identifier_exists=no`);
      assert.ok(bloc.includes('<g:description><![CDATA['), `${p.sku} : description`);
    }
    const dek = items.get(FIXTURE.produits.find((p) => p.sku.startsWith('DEK-'))._id);
    assert.equal(portDuFlux(dek), '89.00 EUR');
    /* Boîte de vitesses : pièce lourde, 3–6 j de préparation, 1–4 j de transport. */
    assert.match(dek, /<g:min_handling_time>3<\/g:min_handling_time>\s*<g:max_handling_time>6<\/g:max_handling_time>\s*<g:min_transit_time>1<\/g:min_transit_time>\s*<g:max_transit_time>4<\/g:max_transit_time>/);
    const blocPhare = items.get(String(phare._id));
    assert.equal(portDuFlux(blocPhare), '12.90 EUR');
    assert.equal(champ(blocPhare, 'max_handling_time'), '3', 'phare : pièce standard, 1–3 j');
    assert.equal(champ(blocPhare, 'google_product_category'), '3318');
    assert.equal(champ(items.get(String(pont._id)), 'google_product_category'), '2641');
  });

  await t.test('flux allemand : port du panier vers l’Allemagne, 2–4 j de transport', async () => {
    feedDe._invalidateCache();
    const r = await get('/google-merchant-feed-de.xml');
    assert.equal(r.status, 200);
    verifierXmlBienForme(r.corps);
    const items = articles(r.corps);
    assert.ok(items.size >= 3, `${items.size} articles`);
    for (const [id, bloc] of items) {
      const p = await Product.findById(id).lean();
      assert.equal(portDuFlux(bloc), euros(await portPanier(p, { country: 'Allemagne', postalCode: '10115' }, 'de')), `${p.sku} : port DE`);
      assert.match(bloc, /<g:country>DE<\/g:country>/);
      assert.match(bloc, /<g:min_transit_time>2<\/g:min_transit_time>\s*<g:max_transit_time>4<\/g:max_transit_time>/);
      assert.ok(!/ISO\s?9001/i.test(bloc) || p.sku.startsWith('ALV-PT-'), `${p.sku} : ISO 9001 dans le flux allemand`);
    }
  });

  await t.test('un tarif modifié après la construction relance le flux (classe, puis catégorie)', async () => {
    feedFr._invalidateCache();
    const dekId = FIXTURE.produits.find((p) => p.sku.startsWith('DEK-'))._id;
    assert.equal(portDuFlux(articles((await get('/google-merchant-feed.xml')).corps).get(dekId)), '89.00 EUR');
    await new Promise((r) => setTimeout(r, 5));
    await ShippingClass.updateOne({ _id: classeBoite }, { $set: { 'zonePricesCents.metropole': 9900, domicilePriceCents: 9900 } });
    assert.equal(portDuFlux(articles((await get('/google-merchant-feed.xml')).corps).get(dekId)), '99.00 EUR', 'classe modifiée : nouveau port');
    await new Promise((r) => setTimeout(r, 5));
    await Category.updateOne({ name: 'Boîtes de vitesses' }, { $set: { shippingClassId: classePalette } });
    assert.equal(portDuFlux(articles((await get('/google-merchant-feed.xml')).corps).get(dekId)), '149.00 EUR', 'catégorie modifiée : nouveau port');
  });
});
