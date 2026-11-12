/**
 * Quand Ringover refuse, l'appelant doit quand même recevoir un message.
 *
 * Lancé par : npm test
 *
 * Base : mongodb-memory-server. MONGODB_URI est volontairement IGNORÉE : dans
 * ce dépôt elle désigne la PRODUCTION. Les deux fournisseurs de SMS sont
 * désarmés (aucune clé) : AUCUN message réel ne part d'ici.
 *
 * ── Ce qu'on protège ────────────────────────────────────────────────────────
 *
 * Du 25/09 au 15/10/2026, l'API Ringover a répondu « 403 insufficient
 * permissions » à chaque envoi — vérifié depuis deux réseaux sans rien de
 * commun, avec une clé reconnue (une clé inconnue donne 401). Pendant ces
 * vingt jours, une trentaine de personnes par jour ont appelé sans obtenir
 * personne et sans recevoir le moindre message.
 *
 * Le repli n'est pas aussi bon que Ringover : l'expéditeur Brevo est
 * alphanumérique, le client ne peut pas répondre. Le texte doit donc donner le
 * NUMÉRO à rappeler, et ne contenir aucun lien — les opérateurs français les
 * filtrent. Ces tests figent ces trois règles.
 */

process.env.BRAND = 'autoliva';
/* Les deux canaux désarmés : rien ne peut partir pour de vrai. */
delete process.env.RINGOVER_API_KEY;
delete process.env.RINGOVER_SMS_FROM;
process.env.BREVO_API_KEY = '';
process.env.RINGOVER_SONDE = 'off';
/* Le numéro mobile Ringover reste joignable EN RÉCEPTION même quand l'API
   refuse d'envoyer : c'est par lui que le client répond. */
process.env.RINGOVER_SMS_FROM = '+33745880085';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const AbandonedCart = require('../../src/models/AbandonedCart');
const ringoverCalls = require('../../src/services/ringoverCalls');
const repli = require('../../src/services/accuseAppelRepli');
const brand = require('../../src/config/brand');

let memoire;

test.before(async () => {
  const uri = process.env.TEST_MONGODB_URI || (memoire = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await AbandonedCart.deleteMany({ sessionId: /^test-repli-/ });
    await mongoose.disconnect();
  }
  if (memoire) await memoire.stop();
});

async function unLead(suffixe) {
  return AbandonedCart.create({
    sessionId: `test-repli-${suffixe}`,
    abandonedAt: new Date(),
    phone: '+33612345678',
    captureSource: 'appel_manque',
  });
}

test('le message demande le motif et dit par quel numéro répondre', () => {
  const t = repli.texteRepli('devis', 'Jean', 'boîte');
  assert.match(t, /07 45 88 00 85/, 'le mobile qui REÇOIT les SMS doit y être');
  assert.match(t, /\?/, 'le motif doit être demandé : c’est tout l’intérêt de l’accusé');
  assert.doesNotMatch(t, /https?:\/\/|www\./i, 'aucun lien : les opérateurs les filtrent');
  assert.doesNotMatch(t, /^(?!.*pas de reponse).*repondez/i,
    'ne jamais dire « repondez » : l’expéditeur Brevo ne reçoit rien, le réflexe part dans le vide');
  assert.match(t, /Ecrivez-nous|par SMS au/i, 'il faut nommer le geste : écrire à un autre numéro');
  assert.match(t, /pas de reponse a ce SMS/i,
    'le client doit savoir que répondre à CE message ne mène nulle part');
  assert.doesNotMatch(t, /[àâäéèêëîïôöùûüç]/i, 'pas d’accent : sinon le SMS passe en UCS-2 et coûte double');
  assert.match(t, /Jean/, 'le prénom connu doit être utilisé');
  assert.match(t, /boite/, 'la pièce doit être nommée, sans accent');
  assert.ok(t.length <= 160, `un seul segment attendu, ${t.length} caractères`);
});

test('un prénom long ne fait jamais basculer sur un second SMS', () => {
  const t = repli.texteRepli('devis', 'Christopher', 'moteur');
  assert.ok(t.length <= repli.UN_SEGMENT, `${t.length} caractères`);
  assert.match(t, /^Bonjour, /, 'le prénom cède la place plutôt que de coûter un segment de plus');
});

test('les quatre messages tiennent en un seul SMS', () => {
  for (const [sujet, prenom, piece] of [['devis', 'Jean', 'boîte'], ['commande', '', ''], ['sav', 'Marie', ''], ['', '', '']]) {
    const t = repli.texteRepli(sujet, prenom, piece);
    assert.ok(t.length <= 160, `« ${sujet || 'défaut'} » fait ${t.length} caractères`);
  }
});

test('sans mobile configuré, on ne demande rien qu’on ne puisse recevoir', () => {
  const avant = process.env.RINGOVER_SMS_FROM;
  delete process.env.RINGOVER_SMS_FROM;
  try {
    const t = repli.texteRepli('commande', '', '');
    assert.doesNotMatch(t, /Repondez par SMS/i,
      'sans numéro qui reçoit, demander une réponse serait un piège');
    assert.match(t, new RegExp(brand.PHONE.replace(/ /g, '\\s')), 'il reste la ligne principale');
  } finally {
    process.env.RINGOVER_SMS_FROM = avant;
  }
});

test('sans prénom, la phrase reste correcte', () => {
  const t = repli.texteRepli('', '', '');
  assert.match(t, /^Bonjour, /);
  assert.doesNotMatch(t, /, ,|Bonjour ,/);
});

test('on ne replie que sur une panne de canal, jamais sur un destinataire impossible', () => {
  assert.equal(repli.justifieUnRepli('http_403'), true);
  assert.equal(repli.justifieUnRepli('http_401'), true);
  assert.equal(repli.justifieUnRepli('credits_epuises'), true);
  assert.equal(repli.justifieUnRepli('reseau'), true);
  assert.equal(repli.justifieUnRepli('non_configure'), true);
  assert.equal(repli.justifieUnRepli('destinataire_hors_perimetre'), false,
    'une ligne fixe ne recevra pas mieux par Brevo : ne pas réessayer');
  assert.equal(repli.justifieUnRepli('destinataire_invalide'), false);
});

test('Ringover désarmé : le repli est tenté, et tracé sur la fiche', async () => {
  const lead = await unLead('canal-coupe');
  const note = await ringoverCalls.accuserReception(String(lead._id), '+33612345678', { sujet: 'commande' });

  const apres = await AbandonedCart.findById(lead._id).lean();
  const lignes = apres.communications || [];
  const ringover = lignes.find((l) => l.gabarit === 'ringover_accuse');
  const brevo = lignes.find((l) => l.gabarit === 'accuse_appel_repli');

  assert.ok(ringover, 'l’échec Ringover doit être journalisé');
  assert.equal(ringover.statut, 'echec');
  assert.ok(brevo, 'la tentative de repli doit être journalisée, réussie ou non');
  /* Brevo est désarmé dans ce test : l'échec est attendu, et c'est bien ce
     qu'on veut voir écrit plutôt qu'un silence. */
  assert.equal(brevo.statut, 'echec');
  assert.match(brevo.motif, /missing_api_key|inconnu/);
  assert.match(note, /Aucun SMS envoyé/);
});

test('un numéro hors périmètre ne déclenche aucun repli', async () => {
  const lead = await unLead('hors-perimetre');
  /* Ringover désarmé rend « non_configure » avant même de juger le numéro :
     on vérifie donc la règle au niveau où elle est écrite. */
  assert.equal(repli.justifieUnRepli('destinataire_hors_perimetre'), false);
  await AbandonedCart.deleteOne({ _id: lead._id });
});

test('le plafond d’un message par 24 h s’applique aussi au repli', async () => {
  const lead = await unLead('plafond');
  await AbandonedCart.updateOne({ _id: lead._id }, { $set: { ringoverSmsSentAt: new Date() } });
  const note = await ringoverCalls.accuserReception(String(lead._id), '+33612345678', {});
  assert.match(note, /déjà envoyé/);
  const apres = await AbandonedCart.findById(lead._id).lean();
  assert.equal((apres.communications || []).length, 0, 'aucun envoi ne doit être tenté');
});
