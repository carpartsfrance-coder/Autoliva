/**
 * Import des conversions Google Ads : la MARGE, les remboursements, et les
 * ventes conclues au téléphone après une demande de devis — contre un VRAI
 * MongoDB (mongodb-memory-server). Seul l'envoi à Google est remplacé : les
 * événements sont capturés, aucun appel réseau.
 *
 * Diagnostic du 08/11/2026 :
 *  - Google recevait le total TTC (TVA, port, consigne) → il visait le chiffre
 *    d'affaires, pas le bénéfice ;
 *  - une vente remboursée restait une vente chez Google ;
 *  - 187 demandes de devis en 30 jours (presque toutes via Google Ads), 0 vente
 *    remontée : les commandes saisies au téléphone n'étaient reliées à rien.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

delete process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT;

const Order = require('../../src/models/Order');
const AbandonedCart = require('../../src/models/AbandonedCart');
const Product = require('../../src/models/Product');
const User = require('../../src/models/User');
const gAds = require('../../src/services/googleAdsConversions');
const { syncConversions } = require('../../src/services/googleAdsConversionSync');

const JOUR = 86400000;
const MAINTENANT = new Date('2026-11-09T10:00:00Z');
const ilYa = (jours) => new Date(MAINTENANT.getTime() - jours * JOUR);

let serveur;
const envois = [];
let n = 0;

const ADRESSE = { fullName: 'Client Test', line1: '1 rue de Paris', postalCode: '75001', city: 'Paris', country: 'France' };

async function client(email, phone = '') {
  const r = await User.collection.insertOne({
    firstName: 'Client', lastName: 'Test', email, phone, passwordHash: 'x', passwordSalt: 'y',
    accountType: 'particulier', addresses: [], createdAt: ilYa(100), updatedAt: ilYa(100),
  });
  return r.insertedId;
}

async function commande(over = {}) {
  n += 1;
  const doc = {
    userId: new mongoose.Types.ObjectId(),
    number: `CP2026-98${String(n).padStart(4, '0')}`,
    status: 'processing',
    paymentStatus: 'paid',
    accountType: 'particulier',
    vatScheme: 'normal',
    totalCents: 107900,
    shippingCostCents: 8900,
    consigne: { chargedTotalCents: 10000 },
    items: [{ name: 'Boîte de transfert Macan', unitPriceCents: 89000, quantity: 1, lineTotalCents: 89000 }],
    shippingAddress: { ...ADRESSE },
    billingAddress: { ...ADRESSE },
    refunds: [],
    source: { channel: 'website' },
    isManual: false,
    deletedAt: null,
    createdAt: ilYa(2),
    updatedAt: ilYa(2),
    ...over,
  };
  await Order.collection.insertOne(doc);
  return doc;
}

async function lead(over = {}) {
  n += 1;
  const doc = {
    sessionId: `s-${n}`,
    captureSource: 'landing_ponts',
    email: '',
    phone: '',
    status: 'new',
    items: [],
    requested: { ref: `AUT-2026-10-${String(n).padStart(6, '0')}` },
    attribution: { source: 'google', medium: 'cpc', campaign: '', referrer: '', gclid: `GCLID-LEAD-${n}`, gbraid: '', wbraid: '' },
    googleAdsUpload: { leadAt: ilYa(1), quoteAt: null, saleAt: null },
    createdAt: ilYa(20),
    updatedAt: ilYa(20),
    ...over,
  };
  await AbandonedCart.collection.insertOne(doc);
  return doc;
}

const lire = (doc) => Order.findById(doc._id).lean();
const envoisPour = (tx) => envois.filter((e) => e.transactionId === tx);

test('Google Ads : marge, remboursements et ventes après demande de devis', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());

  const vrais = { isConfigured: gAds.isConfigured, uploadConversion: gAds.uploadConversion };
  gAds.isConfigured = () => true;
  gAds.uploadConversion = async (p) => { envois.push(p); return { ok: true, validateOnly: !!p.dryRun }; };

  t.after(async () => {
    gAds.isConfigured = vrais.isConfigured;
    gAds.uploadConversion = vrais.uploadConversion;
    await mongoose.disconnect();
    await serveur.stop();
  });

  const macan = await Product.collection.insertOne({ name: 'Boîte de transfert Macan', costCents: 50000, priceCents: 89000, slug: 'macan' });
  const ligneMacan = [{ productId: macan.insertedId, name: 'Boîte de transfert Macan', unitPriceCents: 89000, quantity: 1, lineTotalCents: 89000 }];

  // ── Les données ──
  const achatSite = await commande({
    items: ligneMacan,
    attribution: { lastTouch: { gclid: 'GCLID-ACHAT', utmSource: 'google', utmMedium: 'cpc' }, uploadedToGoogleAdsAt: null },
  });
  const ancienEnvoi = await commande({ // envoyé avant ce correctif : sans identifiant de transaction
    items: ligneMacan, status: 'refunded',
    attribution: { lastTouch: { gclid: 'GCLID-VIEUX' }, uploadedToGoogleAdsAt: ilYa(10) },
  });

  const demandeTel = await lead({ phone: '06 12 34 56 78' });
  const venteTel = await commande({ // Ford Transit, saisie à la main, même téléphone écrit autrement
    source: { channel: 'phone' }, isManual: true, totalCents: 372000, shippingCostCents: 0, consigne: { chargedTotalCents: 0 },
    items: [{ name: 'Pont arrière Ford Transit', unitPriceCents: 310000, quantity: 1, lineTotalCents: 310000 }],
    shippingAddress: { ...ADRESSE, phone: '+33 6 12 34 56 78' }, createdAt: ilYa(5),
  });

  const demandeRef = await lead({ phone: '07 00 00 00 01', requested: { ref: 'AUT-2026-10-ABC123' } });
  const venteRef = await commande({ // n° de dossier saisi, téléphone différent
    source: { channel: 'phone' }, isManual: true, quoteReference: 'aut-2026-10-abc123',
    shippingAddress: { ...ADRESSE, phone: '0699999999' }, createdAt: ilYa(3),
  });

  const userEmail = await client('jean.dupont@example.com');
  await lead({ email: 'Jean.Dupont@example.com', captureSource: 'landing_boites' });
  const venteEmail = await commande({ userId: userEmail, source: { channel: 'whatsapp' }, isManual: true, createdAt: ilYa(4) });

  await lead({ phone: '0611111111', createdAt: ilYa(1) }); // demande APRÈS la commande
  const avantDemande = await commande({ isManual: true, shippingAddress: { ...ADRESSE, phone: '0611111111' }, createdAt: ilYa(3) });

  await lead({ phone: '0622222222', createdAt: ilYa(150) }); // trop vieille (> 80 j avant la commande)
  const tropTard = await commande({ isManual: true, shippingAddress: { ...ADRESSE, phone: '0622222222' }, createdAt: ilYa(40) });

  await lead({ phone: '0633333333', engineQuote: { status: 'won', pricing: { sellPrice: 1000, purchasePrice: 0 } }, captureSource: 'landing_moteurs' });
  const dejaVendueParDevis = await commande({ isManual: true, shippingAddress: { ...ADRESSE, phone: '0633333333' }, createdAt: ilYa(2) });

  await lead({ phone: '0644444444', attribution: { gclid: '', gbraid: '', wbraid: '' } }); // pas venue d'une pub
  const sansClic = await commande({ isManual: true, shippingAddress: { ...ADRESSE, phone: '0644444444' } });

  await t.test('essai à blanc (diagnostic) : rien n\'est marqué en base', async () => {
    envois.length = 0;
    const r = await syncConversions({ dryRun: true, now: MAINTENANT });
    assert.ok(envois.length > 0 && envois.every((e) => e.dryRun === true));
    assert.strictEqual(r.ventesCommandes.eligible, 3);
    assert.strictEqual((await lire(achatSite)).attribution.uploadedToGoogleAdsAt, null);
    assert.ok(!(await lire(venteTel)).googleAdsConversion || !(await lire(venteTel)).googleAdsConversion.uploadedAt);
  });

  await t.test('premier passage', async () => {
    envois.length = 0;
    const r = await syncConversions({ dryRun: false, now: MAINTENANT });

    // Achat sur le site : la marge (890 € TTC − 500 € HT), plus le total TTC.
    const [eAchat] = envoisPour(achatSite.number);
    assert.strictEqual(eAchat.action, 'purchase');
    assert.strictEqual(eAchat.value, 241.67);
    assert.strictEqual(eAchat.gclid, 'GCLID-ACHAT');
    const cAchat = await lire(achatSite);
    assert.ok(cAchat.attribution.uploadedToGoogleAdsAt);
    assert.strictEqual(cAchat.googleAdsConversion.transactionId, achatSite.number);
    assert.strictEqual(cAchat.googleAdsConversion.valueCents, 24167);
    assert.strictEqual(cAchat.googleAdsConversion.estimated, false);

    // Vente au téléphone : rattachée à la demande (même numéro), clic de la demande, marge estimée.
    const [eTel] = envoisPour(venteTel.number);
    assert.strictEqual(eTel.action, 'sale');
    assert.strictEqual(eTel.gclid, demandeTel.attribution.gclid);
    assert.strictEqual(eTel.value, 1550, 'pont 3 100 € HT, prix d\'achat inconnu → 50 % estimés');
    assert.strictEqual(eTel.email, undefined, 'le clic suffit : pas de données personnelles en plus');
    assert.strictEqual(eTel.phone, undefined);
    const cTel = await lire(venteTel);
    assert.strictEqual(cTel.googleAdsConversion.action, 'sale');
    assert.strictEqual(String(cTel.googleAdsConversion.leadId), String(demandeTel._id));
    assert.strictEqual(cTel.googleAdsConversion.estimated, true);
    const dTel = await AbandonedCart.findById(demandeTel._id).lean();
    assert.ok(dTel.googleAdsUpload.saleAt);
    assert.strictEqual(dTel.googleAdsUpload.saleVia, 'commande');

    // N° de dossier saisi sur la commande (casse indifférente).
    assert.strictEqual(envoisPour(venteRef.number)[0].gclid, demandeRef.attribution.gclid);
    // Même e-mail (casse indifférente).
    assert.strictEqual(envoisPour(venteEmail.number).length, 1);

    // Jamais rattachées : demande après la commande, demande trop vieille, déjà
    // vendue par l'outil devis, demande sans clic pub.
    for (const o of [avantDemande, tropTard, dejaVendueParDevis, sansClic]) {
      assert.strictEqual(envoisPour(o.number).length, 0, o.number);
    }
    // Ancien envoi (sans identifiant) remboursé : impossible à corriger, on n'y touche pas.
    assert.strictEqual(envoisPour(ancienEnvoi.number).length, 0);

    // Le devis gagné dans l'outil devis : marge estimée, identifiant DEVIS-…
    const eDevis = envois.find((e) => e.action === 'sale' && /^DEVIS-/.test(e.transactionId || ''));
    assert.ok(eDevis);
    assert.strictEqual(eDevis.value, 500, 'prix d\'achat inconnu : 50 % du prix de vente, pas le prix entier');

    assert.strictEqual(r.ventesCommandes.uploaded, 3);
    assert.strictEqual(r.purchases.uploaded, 1);
    assert.strictEqual(r.ajustements.eligible, 0);
  });

  await t.test('second passage : rien n\'est renvoyé', async () => {
    envois.length = 0;
    const r = await syncConversions({ dryRun: false, now: MAINTENANT });
    assert.strictEqual(envois.filter((e) => e.action === 'purchase' || e.action === 'sale').length, 0);
    assert.strictEqual(r.ajustements.eligible, 0);
  });

  await t.test('prix d\'achat saisi après coup : la marge estimée est corrigée chez Google', async () => {
    await Order.collection.updateOne({ _id: venteTel._id }, { $set: { 'purchase.priceCents': 180000, 'purchase.supplierRegime': 'intracom_autoliquidation' } });
    envois.length = 0;
    const r = await syncConversions({ dryRun: false, now: MAINTENANT });
    const [e] = envoisPour(venteTel.number);
    assert.strictEqual(e.action, 'sale');
    assert.strictEqual(e.value, 1300, '3 100 € HT − 1 800 € d\'achat');
    assert.strictEqual(e.gclid, demandeTel.attribution.gclid, 'même clic, même identifiant');
    assert.strictEqual(e.valeurExplicite, true);
    assert.strictEqual(r.ajustements.uploaded, 1);
    const c = await lire(venteTel);
    assert.strictEqual(c.googleAdsConversion.valueCents, 130000);
    assert.strictEqual(c.googleAdsConversion.estimated, false);
    assert.ok(c.googleAdsConversion.restatedAt);
  });

  await t.test('remboursement total : la vente passe à 0 chez Google, une seule fois', async () => {
    await Order.collection.updateOne({ _id: achatSite._id }, {
      $set: { status: 'refunded' },
      $push: { refunds: { amountCents: 107900, kind: 'standard', method: 'mollie', createdAt: MAINTENANT, createdBy: 'test' } },
    });
    envois.length = 0;
    await syncConversions({ dryRun: false, now: MAINTENANT });
    const [e] = envoisPour(achatSite.number);
    assert.strictEqual(e.action, 'purchase');
    assert.strictEqual(e.value, 0);
    assert.strictEqual(e.valeurExplicite, true, 'la valeur 0 doit partir explicitement');
    assert.strictEqual(e.transactionId, achatSite.number);
    const c = await lire(achatSite);
    assert.strictEqual(c.googleAdsConversion.final, true);

    envois.length = 0;
    await syncConversions({ dryRun: false, now: MAINTENANT });
    assert.strictEqual(envoisPour(achatSite.number).length, 0, 'Google n\'accepte plus de correction après 0');
  });

  await t.test('une 2e commande du même client après sa demande compte aussi, une fois', async () => {
    const seconde = await commande({ isManual: true, shippingAddress: { ...ADRESSE, phone: '06.12.34.56.78' }, createdAt: ilYa(1) });
    envois.length = 0;
    await syncConversions({ dryRun: false, now: MAINTENANT });
    assert.strictEqual(envoisPour(seconde.number).length, 1);
    const d = await AbandonedCart.findById(demandeTel._id).lean();
    assert.strictEqual(d.googleAdsUpload.saleOrderIds.length, 2);
  });

  await t.test('commande remboursée avant tout envoi : jamais envoyée', async () => {
    const remb = await commande({ status: 'refunded', attribution: { lastTouch: { gclid: 'GCLID-REMB' } } });
    envois.length = 0;
    await syncConversions({ dryRun: false, now: MAINTENANT });
    assert.strictEqual(envoisPour(remb.number).length, 0);
  });
});
