/**
 * Tests unitaires — connecteur Comptoir (getcomptoir.fr).
 *
 * Référence : https://getcomptoir.fr/guide-connecteur.html
 *
 * Lancé par : npm test  (aucune base, aucun réseau — fetch est remplacé)
 */

const test = require('node:test');
const assert = require('node:assert');

const comptoir = require('../../src/services/comptoir');

const commande = (over = {}) => Object.assign({
  number: 'CP2026-000485',
  status: 'processing',
  paymentStatus: 'paid',
  totalCents: 129900,
  createdAt: new Date('2026-09-01T10:00:00Z'),
  molliePaidAt: new Date('2026-09-01T10:04:00Z'),
  items: [{ name: 'Mécatronique DQ200 reconditionnée' }],
  billingAddress: { fullName: 'Jean Dupont' },
  shippingAddress: { fullName: 'Jean Dupont' },
}, over);

/* ── Payload ─────────────────────────────────────────────────────────────── */

test('le payload respecte les champs du guide Comptoir', () => {
  const p = comptoir.buildPayload(commande());
  assert.equal(p.externalId, 'CP2026-000485');
  assert.equal(p.amount, 1299);                     // euros, pas centimes
  assert.equal(p.status, 'preparation');
  assert.equal(p.customerName, 'Jean Dupont');
  assert.equal(p.productName, 'Mécatronique DQ200 reconditionnée');
  assert.equal(p.date, '2026-09-01T10:04:00.000Z'); // l'encaissement, pas la création
});

test('le montant est en euros et supporte les centimes', () => {
  assert.equal(comptoir.buildPayload(commande({ totalCents: 4290 })).amount, 42.9);
  assert.equal(comptoir.buildPayload(commande({ totalCents: 1 })).amount, 0.01);
});

test('sans date d’encaissement, on retombe sur la date de création', () => {
  const p = comptoir.buildPayload(commande({ molliePaidAt: null, scalapayCapturedAt: null }));
  assert.equal(p.date, '2026-09-01T10:00:00.000Z');
});

test('plusieurs articles : le premier, en signalant les autres', () => {
  const deux = comptoir.buildProductName(commande({ items: [{ name: 'Pont arrière' }, { name: 'Cardan' }] }));
  assert.equal(deux, 'Pont arrière (+1 autre)');

  const trois = comptoir.buildProductName(commande({ items: [{ name: 'Pont' }, { name: 'A' }, { name: 'B' }] }));
  assert.equal(trois, 'Pont (+2 autres)');
});

test('les champs facultatifs vides ne sont pas envoyés', () => {
  const p = comptoir.buildPayload(commande({
    items: [], billingAddress: { fullName: '' }, shippingAddress: { fullName: '' },
  }));
  assert.equal('productName' in p, false);
  assert.equal('customerName' in p, false);
  assert.equal(p.amount, 1299); // le montant, lui, reste obligatoire
});

test('le nom de facturation prime, avec repli sur la livraison', () => {
  const p = comptoir.buildPayload(commande({
    billingAddress: { fullName: '' },
    shippingAddress: { fullName: 'Garage Martin' },
  }));
  assert.equal(p.customerName, 'Garage Martin');
});

/* ── Statuts ─────────────────────────────────────────────────────────────── */

test('les statuts Autoliva tombent dans les trois statuts Comptoir', () => {
  const ATTENDUS = new Set(['livree', 'preparation', 'retour']);
  const table = {
    paid: 'preparation', processing: 'preparation', label_created: 'preparation',
    shipped: 'livree', delivered: 'livree', completed: 'livree',
    cancelled: 'retour', refunded: 'retour', partially_refunded: 'retour',
  };
  for (const [autoliva, attendu] of Object.entries(table)) {
    assert.equal(comptoir.mapStatus(autoliva), attendu, autoliva);
    assert.ok(ATTENDUS.has(comptoir.mapStatus(autoliva)));
  }
});

test('un statut inconnu ne casse rien : préparation par défaut', () => {
  assert.equal(comptoir.mapStatus('statut_invente'), 'preparation');
  assert.equal(comptoir.mapStatus(''), 'preparation');
  assert.equal(comptoir.mapStatus(undefined), 'preparation');
});

/* ── Éligibilité ─────────────────────────────────────────────────────────── */

test('seules les commandes encaissées sont comptées', () => {
  assert.equal(comptoir.isEncaissee(commande({ paymentStatus: 'paid' })), true);
  assert.equal(comptoir.isEncaissee(commande({ paymentStatus: 'captured' })), true);
  assert.equal(comptoir.isEncaissee(commande({ paymentStatus: 'completed' })), true);

  /* Un brouillon passé « processing » à la main sans encaissement ne doit pas
     gonfler le compteur : c'est paymentStatus qui tranche, pas status. */
  assert.equal(comptoir.isEncaissee(commande({ paymentStatus: 'pending' })), false);
  assert.equal(comptoir.isEncaissee(commande({ paymentStatus: 'failed' })), false);
  assert.equal(comptoir.isEncaissee(null), false);
});

/* ── Envoi HTTP ──────────────────────────────────────────────────────────── */

test('sans clé API, aucun appel réseau n’est tenté', async () => {
  const cle = process.env.COMPTOIR_API_KEY;
  delete process.env.COMPTOIR_API_KEY;
  const vraiFetch = global.fetch;
  global.fetch = () => { throw new Error('fetch ne devrait pas être appelé'); };
  try {
    const r = await comptoir.pushOrder(commande());
    assert.equal(r.skipped, true);
    assert.equal(r.ok, false);
  } finally {
    global.fetch = vraiFetch;
    if (cle !== undefined) process.env.COMPTOIR_API_KEY = cle;
  }
});

test('un montant nul n’est pas envoyé (400 garanti côté Comptoir)', async () => {
  process.env.COMPTOIR_API_KEY = 'cle-de-test';
  const vraiFetch = global.fetch;
  global.fetch = () => { throw new Error('fetch ne devrait pas être appelé'); };
  try {
    const r = await comptoir.pushOrder(commande({ totalCents: 0 }));
    assert.equal(r.ok, false);
    assert.equal(r.permanent, true, 'inutile de réessayer un montant nul');
  } finally {
    global.fetch = vraiFetch;
    delete process.env.COMPTOIR_API_KEY;
  }
});

test('la requête porte la clé en Bearer et un corps JSON', async () => {
  process.env.COMPTOIR_API_KEY = 'cle-de-test';
  const vraiFetch = global.fetch;
  let vueUrl = '';
  let vuesOptions = null;
  global.fetch = async (url, options) => {
    vueUrl = url; vuesOptions = options;
    return { status: 200, text: async () => JSON.stringify({ ok: true, duplicate: false }) };
  };
  try {
    const r = await comptoir.pushOrder(commande());
    assert.equal(r.ok, true);
    assert.equal(vueUrl, comptoir.DEFAULT_ENDPOINT);
    assert.equal(vuesOptions.method, 'POST');
    assert.equal(vuesOptions.headers.Authorization, 'Bearer cle-de-test');
    assert.equal(vuesOptions.headers['Content-Type'], 'application/json');
    assert.equal(JSON.parse(vuesOptions.body).externalId, 'CP2026-000485');
  } finally {
    global.fetch = vraiFetch;
    delete process.env.COMPTOIR_API_KEY;
  }
});

test('un doublon est un succès, pas une erreur', async () => {
  process.env.COMPTOIR_API_KEY = 'cle-de-test';
  const vraiFetch = global.fetch;
  global.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ duplicate: true }) });
  try {
    const r = await comptoir.pushOrder(commande());
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, true);
  } finally {
    global.fetch = vraiFetch;
    delete process.env.COMPTOIR_API_KEY;
  }
});

test('400 et 401 sont définitifs, une panne réseau ne l’est pas', async () => {
  process.env.COMPTOIR_API_KEY = 'cle-de-test';
  const vraiFetch = global.fetch;
  try {
    global.fetch = async () => ({ status: 401, text: async () => JSON.stringify({ error: 'Clé API invalide ou révoquée.' }) });
    const cleMorte = await comptoir.pushOrder(commande());
    assert.equal(cleMorte.ok, false);
    assert.equal(cleMorte.permanent, true);
    assert.match(cleMorte.error, /Clé API invalide/);

    global.fetch = async () => ({ status: 500, text: async () => 'boom' });
    const panne = await comptoir.pushOrder(commande());
    assert.equal(panne.ok, false);
    assert.equal(panne.permanent, false, 'une 500 doit être réessayée');

    global.fetch = async () => { throw new Error('ECONNRESET'); };
    const reseau = await comptoir.pushOrder(commande());
    assert.equal(reseau.ok, false);
    assert.ok(!reseau.permanent, 'une coupure réseau doit être réessayée');
  } finally {
    global.fetch = vraiFetch;
    delete process.env.COMPTOIR_API_KEY;
  }
});

test('une réponse non JSON ne fait pas tomber le connecteur', async () => {
  process.env.COMPTOIR_API_KEY = 'cle-de-test';
  const vraiFetch = global.fetch;
  global.fetch = async () => ({ status: 200, text: async () => '<html>Bad Gateway</html>' });
  try {
    const r = await comptoir.pushOrder(commande());
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, false);
  } finally {
    global.fetch = vraiFetch;
    delete process.env.COMPTOIR_API_KEY;
  }
});
