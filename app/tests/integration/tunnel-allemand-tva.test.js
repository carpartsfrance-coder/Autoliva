/**
 * Autoliquidation de TVA au PAIEMENT, côté allemand (09/2026).
 *
 * Le récapitulatif collé au bouton « Zahlungspflichtig bestellen » est celui
 * qu'exige le § 312j Abs. 2 BGB : il annonce le TOTAL du contrat. Pour un
 * Geschäftskunde allemand qui saisit sa USt-IdNr., il affichait « TVA —
 * autoliquidée », « Total HT » et une mention citant le CGI — en français, sur
 * une page entièrement allemande.
 *
 * Fichier séparé : le drapeau VAT_REVERSE_CHARGE_ENABLED est lu au CHARGEMENT
 * du contrôleur, et node:test isole chaque fichier dans son propre processus.
 *
 * Aucun appel réseau : la réponse VIES est remplacée ici même (l'appel réel est
 * couvert par ses propres tests) ; clés d'envoi et de paiement vides.
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
/* Doit être posé AVANT le require du contrôleur de commande. */
process.env.VAT_REVERSE_CHARGE_ENABLED = 'true';

/* VIES répond « valide » sans sortir du processus. */
const viesValidator = require('../../src/services/viesValidator');
viesValidator.validateVat = async (numero) => ({
  valid: true, status: 'valid', countryCode: String(numero || '').slice(0, 2), vatNumber: String(numero || ''), checkedAt: new Date(),
});

const FIXTURE = require('../fixtures/fiches-produit-prod.json');
/* Fiche traduite, SANS consigne (l'aperçu est inerte dès qu'une consigne est
   encaissée) et en TVA normale — la seule autoliquidable. */
const SOURCE = FIXTURE.produits.find((p) => p.sku.startsWith('DEK-'));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function versMongo(p) {
  const doc = { ...p };
  delete doc._role;
  doc._id = new mongoose.Types.ObjectId(p._id);
  doc.vatRecoverable = true;
  doc.consigne = { enabled: false, amountCents: 0, delayDays: 30, chargeUpfront: false };
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

function navigateur(base) {
  let cookie = '';
  return async function requete(chemin, { method = 'GET', form } = {}) {
    /* Pas d'en-tête Sec-Fetch- : le fetch de Node impose « sec-fetch-mode:
       cors », et le middleware i18n — à raison — n'y voit pas une navigation. */
    const headers = { 'user-agent': UA, accept: 'text/html' };
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
    const html = await r.text();
    return { status: r.status, location: r.headers.get('location'), html, lu: texte(html) };
  };
}

test('autoliquidation de TVA : le récapitulatif du paiement suit la langue', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  await db.collection('shippingclasses').insertOne({
    name: 'Colis', slug: 'colis', isActive: true, isDefault: true, domicilePriceCents: 6900, zonePricesCents: { metropole: 6900, europe: 9900 },
  });
  const produit = versMongo(SOURCE);
  await db.collection('products').insertOne(produit);

  const app = require('../../src/app');
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
    delete process.env.VAT_REVERSE_CHARGE_ENABLED;
  });

  /** Parcours invité complet jusqu'à l'affichage du paiement. */
  async function jusquAuPaiement({ accueil, pays, tva }) {
    const nav = navigateur(base);
    await nav(accueil);
    await nav(`/panier/ajouter/${produit._id}`, { method: 'POST', form: { qty: '1', returnTo: '/panier' } });
    await nav('/commande/livraison?guest=1');
    const r = await nav('/commande/livraison', {
      method: 'POST',
      form: {
        shippingMethod: 'domicile', email: 'gewerbe@example.com', firstName: 'Max', lastName: 'Muster',
        phone: '+4930123456', line1: 'Hauptstraße 1', postalCode: '10115', city: pays === 'France' ? 'Paris' : 'Berlin',
        country: pays, vatNumberEu: tva,
      },
    });
    assert.equal(r.location, '/commande/paiement', `étape livraison : ${r.status} ${r.location}`);
    return nav('/commande/paiement');
  }

  await t.test('page allemande : plus un mot de français au-dessus du bouton', async () => {
    const paiement = await jusquAuPaiement({ accueil: '/de/', pays: 'Allemagne', tva: 'DE123456789' });
    assert.equal(langueHtml(paiement.html), 'de');
    assert.ok(paiement.lu.includes('Zahlungspflichtig bestellen'), 'bouton de commande absent');

    /* Le récapitulatif MOBILE est celui qui est collé au bouton. */
    const recap = texte((paiement.html.match(/data-recap-mobile[\s\S]*?<\/button>/) || [])[0]);
    assert.ok(recap.includes('USt. — Reverse-Charge'), `ligne de TVA : « ${recap} »`);
    assert.ok(recap.includes('Gesamt netto'), `libellé du total : « ${recap} »`);
    assert.ok(!/TVA|Total HT|autoliquid/.test(recap), `français au-dessus du bouton : « ${recap} »`);

    /* Colonne de droite et mention légale. */
    assert.ok(paiement.lu.includes('USt. — Reverse-Charge (EU-Gewerbe)'), 'colonne de droite en français');
    assert.ok(paiement.lu.includes('Reverse-Charge-Verfahren — USt-IdNr. DE123456789 bestätigt.'), `mention légale : « ${(paiement.lu.match(/Reverse-Charge-Verfahren[^|]{0,140}/) || [])[0]} »`);
    assert.ok(paiement.lu.includes('innergemeinschaftliche Lieferung, Art. 138 MwStSystRL'), 'référence légale absente');
    assert.ok(!/262 ter|CGI|autoliquidée|Total HT/.test(paiement.lu), 'texte français sur la page de paiement allemande');

    /* Le total annoncé est bien le HT : 1 149,00 € + 99,00 € de port = 1 248,00
       TTC, soit 1 040,00 € HT. */
    assert.match(recap, /Gesamt netto 1\s?040,00 €/, `total HT annoncé : « ${recap} »`);
  });

  await t.test('page française : libellés inchangés', async () => {
    const paiement = await jusquAuPaiement({ accueil: '/', pays: 'Autriche', tva: 'ATU46674503' });
    assert.equal(langueHtml(paiement.html), 'fr');
    assert.ok(paiement.lu.includes('TVA — autoliquidée (pro UE)'), 'libellé français modifié');
    assert.ok(paiement.lu.includes('Total HT'), 'libellé « Total HT » modifié');
    assert.ok(paiement.lu.includes('Autoliquidation de la TVA — n° ATU46674503 validé.'), `mention française : « ${(paiement.lu.match(/Autoliquidation de la TVA[^|]{0,140}/) || [])[0]} »`);
    assert.ok(paiement.lu.includes('art. 262 ter I du CGI'), 'référence au CGI perdue côté français');
    const recap = texte((paiement.html.match(/data-recap-mobile[\s\S]*?<\/button>/) || [])[0]);
    assert.ok(recap.includes('TVA — autoliquidée') && recap.includes('Total HT'), `récapitulatif français : « ${recap} »`);
  });

  await t.test('sans n° de TVA : le total reste TTC, dans les deux langues', async () => {
    const de = await jusquAuPaiement({ accueil: '/de/', pays: 'Allemagne', tva: '' });
    assert.ok(!/Reverse-Charge|Gesamt netto/.test(de.lu), 'autoliquidation annoncée sans numéro');
    assert.ok(de.lu.includes('Gesamt'), 'total allemand absent');
    const fr = await jusquAuPaiement({ accueil: '/', pays: 'France', tva: '' });
    assert.ok(!/autoliquid|Total HT/.test(fr.lu), 'autoliquidation annoncée pour une commande France');
  });
});
