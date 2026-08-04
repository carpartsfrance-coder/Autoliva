/**
 * Tests d'intégration — fiche appelant Ringover (webhooks « Contact Call » et
 * « Contact search »).
 *
 * Lancé par : npm test
 *
 * Environnement requis :
 *   TEST_MONGODB_URI : connexion à un MongoDB DE TEST.
 *
 * ⚠ CONTRAIREMENT aux autres tests du dossier, celui-ci NE retombe PAS sur
 * `MONGODB_URI` : dans ce dépôt, cette variable pointe sur l'Atlas de PRODUCTION.
 * Un test qui crée des leads, des commandes et des tickets SAV n'a rien à y
 * faire. Sans `TEST_MONGODB_URI`, on saute — c'est volontaire.
 *
 * Le nettoyage se fait par identifiants collectés, jamais par `dropDatabase` :
 * si quelqu'un pointe malgré tout la variable sur une base peuplée, il perd au
 * pire les documents que le test a lui-même créés.
 *
 * Aucune dépendance externe : node:test + fetch intégrés.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');

const URI = process.env.TEST_MONGODB_URI || '';

/* Variables lues au chargement des modules : à poser AVANT les require(). */
process.env.RINGOVER_WEBHOOK_SECRET = 'secret-de-test-de-32-caracteres!!';
process.env.RINGOVER_WEBHOOK_KEY_CONTACT = 'cle-contact-de-test';
process.env.RINGOVER_WEBHOOK_KEY = 'cle-call-event-de-test';
process.env.BRAND = 'autoliva';
/* Aucun envoi possible depuis un test, quelle que soit la suite des évènements. */
process.env.BREVO_API_KEY = '';
process.env.MAILERSEND_API_KEY = '';
process.env.RINGOVER_API_KEY = '';

const PORT = 4599;
const BASE = 'http://127.0.0.1:' + PORT;
process.env.PUBLIC_BASE_URL = BASE;
const SECRET = process.env.RINGOVER_WEBHOOK_SECRET;

const ringoverRouter = require('../../src/routes/api/ringover');
const AbandonedCart = require('../../src/models/AbandonedCart');
const Order = require('../../src/models/Order');
const SavTicket = require('../../src/models/SavTicket');
const User = require('../../src/models/User');

/* Numéros réservés aux tests : préfixe 0639 98 xx xx, jamais attribué. */
const TEL_LEAD = '+33639980001';
const TEL_CMD = '+33639980002';
const TEL_INCONNU = '+33639980003';
const TEL_MANQUE = '+33639980004';
const TEL_NU = '+33639980005';

let serveur = null;
const aSupprimer = { leads: [], orders: [], savs: [], users: [] };

function jwtV1(cle, url, payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const entete = b64({ alg: 'HS512', typ: 'JWT' });
  const charge = b64({ url, payload });
  const sig = crypto.createHmac('sha512', cle).update(entete + '.' + charge)
    .digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return entete + '.' + charge + '.' + sig;
}

async function envoyer(corps, opts = {}) {
  const { signe = false, cle = null, authorization = null, secret = SECRET } = opts;
  const url = BASE + '/api/ringover/webhook/' + secret;
  const headers = { 'Content-Type': 'application/json' };
  if (signe) headers['x-ringover-webhook-signature'] = jwtV1(cle || 'cle-contact-de-test', url, corps);
  if (authorization) headers.Authorization = authorization;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(corps) });
  const texte = await r.text();
  let json = null;
  try { json = texte ? JSON.parse(texte) : null; } catch (_) { /* 204 sans corps */ }
  return { status: r.status, json };
}

const appel = (data) => envoyer({ event: 'contact', resource: 'call', data });
const recherche = (q) => envoyer({ event: 'contact', ressource: 'search', data: { query_search: q } });

test('fiche appelant Ringover', { skip: URI ? false : 'TEST_MONGODB_URI absent' }, async (t) => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000 });

  const app = express();
  app.use('/api/ringover', ringoverRouter);
  app.use(express.json());
  await new Promise((r) => { serveur = app.listen(PORT, r); });

  t.after(async () => {
    await AbandonedCart.deleteMany({ _id: { $in: aSupprimer.leads } });
    await Order.deleteMany({ _id: { $in: aSupprimer.orders } });
    await SavTicket.deleteMany({ _id: { $in: aSupprimer.savs } });
    await User.deleteMany({ _id: { $in: aSupprimer.users } });
    await AbandonedCart.deleteMany({ phone: TEL_MANQUE });
    if (serveur) serveur.close();
    await mongoose.disconnect();
  });

  /* ── Jeu d'essai ───────────────────────────────────────────────────────── */

  const lead = await AbandonedCart.create({
    sessionId: 'test-ringover-contact-1', phone: TEL_LEAD, isGuest: true,
    firstName: 'Jean', lastName: 'Dupont', email: 'jean.dupont@example.com',
    /* `landing_boites` et non `landing_moteurs` : c'est ce qui prouve que la
       fiche dit « boîte » et pas « moteur ». */
    captureSource: 'landing_boites', status: 'abandoned',
    lastActivityAt: new Date(), abandonedAt: new Date(),
    requested: { plate: 'AB-123-CD', vehicle: 'Golf VI' },
    engineQuote: {
      status: 'new',
      updatedAt: new Date(Date.now() - 11 * 86400000),
      pricing: { sellPrice: 2933 },
      identifiedEngine: { code: 'CFFB', model: 'Golf VI 2.0 TDI' },
    },
  });
  aSupprimer.leads.push(lead._id);

  /* Client connu d'une commande seulement — il a acheté sans passer par un devis.
     Le téléphone d'une commande vit dans les ADRESSES, pas au premier niveau. */
  const adresse = { fullName: 'Marc Leroy', phone: TEL_CMD, line1: '1 rue X', postalCode: '75001', city: 'Paris' };
  const cmd = await Order.create({
    number: 'TEST-RINGOVER-0199', userId: new mongoose.Types.ObjectId(),
    accountType: 'particulier', paymentStatus: 'paid', status: 'processing',
    totalCents: 189000, items: [], billingAddress: adresse, shippingAddress: adresse,
  });
  aSupprimer.orders.push(cmd._id);

  /* ── Cas nominaux ──────────────────────────────────────────────────────── */

  await t.test('un numéro inconnu ne renvoie aucune fiche', async () => {
    const r = await appel({ direction: 'inbound', from_number: TEL_INCONNU });
    assert.equal(r.status, 204, 'Ringover doit afficher le numéro comme avant');
  });

  await t.test('un appelant sans nom ni dossier est quand même reconnu', async () => {
    /* 181 des 839 leads qui portent un téléphone n'ont ni nom ni devis —
       typiquement un appel manqué déjà enregistré. Une première version les
       traitait comme des inconnus, alors que c'est justement là que le
       standardiste a le plus besoin de savoir qu'on a déjà parlé à la personne. */
    const nu = await AbandonedCart.create({
      sessionId: 'test-ringover-nu', phone: TEL_NU, isGuest: true,
      captureSource: 'appel_manque', status: 'abandoned',
      abandonedAt: new Date(), lastActivityAt: new Date(), createdAt: new Date(),
      notes: [
        { text: 'RÉPONSE SMS du client : « Bonjour je veux un pont de GLE 63 »', addedByName: 'Ringover SMS', addedAt: new Date(Date.now() - 60000) },
        /* La note la PLUS RÉCENTE est administrative : c'est le piège rencontré
           en conditions réelles, où la fiche affichait « Statut → Contacté ». */
        { text: 'Statut → Contacté', addedByName: 'Killian', addedAt: new Date() },
      ],
    });
    aSupprimer.leads.push(nu._id);

    const r = await appel({ direction: 'inbound', from_number: TEL_NU });
    assert.equal(r.status, 200, 'un contact connu ne doit pas passer pour un inconnu');
    assert.equal(r.json.lastname, 'Contact connu', 'étiquette, jamais un nom inventé');
    assert.equal(r.json.firstname, '');
    assert.match(r.json.data['Dernier échange'], /pont de GLE 63/,
      'ce que le client a demandé prime sur le changement de statut');
    assert.doesNotMatch(JSON.stringify(r.json.data), /Statut/);
    assert.match(r.json.data['Contact'], /Déjà en base.*appel manqué/);
    assert.ok(r.json.url.endsWith('/admin/activite-panier/' + nu._id));
  });

  await t.test('un dossier ouvert prend la place du contexte de repli', async () => {
    /* Quand il y a un devis ou une commande, la bulle doit montrer ÇA — pas
       « déjà en base », qui n'apprendrait rien. */
    const r = await appel({ direction: 'inbound', from_number: TEL_LEAD });
    assert.ok(r.json.data['Devis']);
    assert.equal(r.json.data['Contact'], undefined);
    assert.equal(r.json.data['Dernier échange'], undefined);
  });

  await t.test('un lead avec devis en attente remonte le dossier', async () => {
    const r = await appel({ direction: 'inbound', from_number: TEL_LEAD.replace('+', '') });
    assert.equal(r.status, 200);
    assert.equal(r.json.firstname, 'Jean');
    assert.equal(r.json.lastname, 'Dupont');
    assert.equal(r.json.is_shared, true, 'sinon la fiche n’est visible que du propriétaire de la clé');
    assert.ok(r.json.url.endsWith('/admin/activite-panier/' + lead._id), r.json.url);
    assert.match(r.json.data['Devis'], /boîte/, 'le lexique doit suivre la catégorie du lead');
    assert.match(r.json.data['Devis'], /À CHIFFRER depuis il y a 11 j/);
    assert.match(r.json.data['Devis'], /2 933 €/);
    assert.equal(r.json.data['Véhicule'], 'Golf VI · AB-123-CD');
  });

  await t.test('un numéro écrit avec des espaces est reconnu', async () => {
    const r = await appel({ direction: 'inbound', from_number: '+33 6 39 98 00 01' });
    assert.equal(r.status, 200);
    assert.equal(r.json.firstname, 'Jean');
  });

  await t.test('une commande non livrée remonte sans lead associé', async () => {
    const r = await appel({ direction: 'inbound', from_number: TEL_CMD });
    assert.equal(r.status, 200);
    assert.equal(r.json.firstname, 'Marc');
    assert.equal(r.json.lastname, 'Leroy');
    assert.ok(r.json.url.endsWith('/admin/commandes/' + cmd._id), r.json.url);
    assert.match(r.json.data['Commande'], /TEST-RINGOVER-0199/);
    assert.match(r.json.data['Commande'], /NON LIVRÉE/);
    assert.match(r.json.data['Commande'], /1 890 €/);
  });

  await t.test('sur un appel sortant, la fiche est celle du DESTINATAIRE', async () => {
    /* Lire `from_number` afficherait notre propre numéro au commercial. */
    const r = await appel({ direction: 'outbound', from_number: '33465848539', to_number: TEL_LEAD });
    assert.equal(r.status, 200);
    assert.equal(r.json.firstname, 'Jean');
  });

  await t.test('un SAV ouvert prend la priorité sur le reste', async () => {
    const sav = await SavTicket.create({
      numero: 'TEST-RINGOVER-SAV-7', statut: 'ouvert', motifSav: 'piece_defectueuse',
      client: { nom: 'Jean Dupont', email: 'jean.dupont@example.com', telephone: TEL_LEAD, type: 'B2B' },
      garage: { nom: 'Garage Central' },
    });
    aSupprimer.savs.push(sav._id);

    const r = await appel({ direction: 'inbound', from_number: TEL_LEAD });
    assert.ok(r.json.url.endsWith('/admin/sav/tickets/TEST-RINGOVER-SAV-7'), r.json.url);
    /* Le motif est stocké en clé technique : il doit être affiché en clair. */
    assert.match(r.json.data['SAV'], /Pièce défectueuse/);
    assert.ok(r.json.data['Devis'], 'le devis reste visible malgré la priorité du SAV');
    assert.equal(r.json.company, 'Garage Central', 'le garage déclaré tient lieu de société');
    assert.equal(r.json.data['Client'], 'Professionnel');
  });

  await t.test('la société du compte client prime sur le garage', async () => {
    const u = await User.create({
      accountType: 'pro', firstName: 'Jean', lastName: 'Dupont',
      email: 'jean.dupont@example.com', passwordHash: 'x', passwordSalt: 'y',
      companyName: 'Garage Dupont SARL',
    });
    aSupprimer.users.push(u._id);
    const r = await appel({ direction: 'inbound', from_number: TEL_LEAD });
    assert.equal(r.json.company, 'Garage Dupont SARL');
  });

  /* ── Recherche ─────────────────────────────────────────────────────────── */

  await t.test('la recherche par nom renvoie un tableau exploitable', async () => {
    const r = await recherche('Dupont');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    const trouve = r.json.find((c) => c.numbers[0].number === TEL_LEAD);
    assert.ok(trouve, 'Jean Dupont doit être trouvé');
    assert.equal(trouve.firstname, 'Jean');
    assert.ok(trouve.url.includes('/admin/activite-panier/'));
  });

  await t.test('la recherche accepte aussi un numéro', async () => {
    const r = await recherche('639980001');
    assert.ok(r.json.some((c) => c.numbers[0].number === TEL_LEAD));
  });

  await t.test('une recherche sans résultat renvoie un tableau vide, pas une erreur', async () => {
    const r = await recherche('Zzzzntrouvable');
    assert.deepEqual(r.json, []);
  });

  await t.test('une recherche trop courte ne balaie pas la base', async () => {
    const r = await recherche('D');
    assert.deepEqual(r.json, []);
  });

  /* ── Sécurité ──────────────────────────────────────────────────────────── */

  await t.test('un mauvais secret d’URL renvoie 404', async () => {
    const temoin = await appel({ from_number: TEL_LEAD });
    assert.equal(temoin.status, 200, 'témoin : avec le bon secret, la route répond');
    const mauvais = await envoyer({ event: 'contact', resource: 'call', data: { from_number: TEL_LEAD } },
      { secret: 'mauvais-secret-de-32-caracteres!!' });
    assert.equal(mauvais.status, 404, 'ne jamais révéler que la route existe');
  });

  await t.test('la signature est vérifiée avec la clé du bloc « Contact Call »', async () => {
    const bonne = await envoyer({ event: 'contact', resource: 'call', data: { from_number: TEL_LEAD } },
      { signe: true, cle: 'cle-contact-de-test' });
    assert.equal(bonne.status, 200);

    /* Signée avec la clé des appels : valide ailleurs, refusée ici. C'est la
       confusion de clés qui rend ce webhook pénible à mettre en service. */
    const mauvaise = await envoyer({ event: 'contact', resource: 'call', data: { from_number: TEL_LEAD } },
      { signe: true, cle: 'cle-call-event-de-test' });
    assert.equal(mauvaise.status, 401);
  });

  await t.test('l’en-tête Authorization de la recherche est contrôlé', async () => {
    const bon = await envoyer({ event: 'contact', ressource: 'search', data: { query_search: 'Dupont' } },
      { authorization: 'cle-contact-de-test' });
    assert.equal(bon.status, 200);
    const mauvais = await envoyer({ event: 'contact', ressource: 'search', data: { query_search: 'Dupont' } },
      { authorization: 'n-importe-quoi' });
    assert.equal(mauvais.status, 401);
  });

  /* ── Robustesse et non-régression ──────────────────────────────────────── */

  await t.test('un corps incomplet ne fait pas tomber la route', async () => {
    assert.equal((await appel({})).status, 204);
    assert.equal((await envoyer({ event: 'contact', resource: 'call' })).status, 204);
    assert.equal((await appel({ from_number: 'pas-un-numero' })).status, 204);
  });

  await t.test('la fiche répond assez vite pour être vue pendant la sonnerie', async () => {
    const t0 = Date.now();
    await appel({ from_number: TEL_LEAD });
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, 'réponse en ' + ms + ' ms — au-delà, l’appel est décroché avant');
  });

  await t.test('les appels manqués continuent de créer un lead', async () => {
    const r = await envoyer({ event: 'missed', resource: 'call', data: { call_id: 'test-ringover-abc', from_number: TEL_MANQUE } });
    assert.equal(r.status, 200);
    assert.ok(await AbandonedCart.findOne({ phone: TEL_MANQUE }).lean());

    const rejeu = await envoyer({ event: 'missed', resource: 'call', data: { call_id: 'test-ringover-abc', from_number: TEL_MANQUE } });
    assert.equal(rejeu.json.action, 'deja_enregistre', 'un rejeu ne doit pas dupliquer');
  });
});
