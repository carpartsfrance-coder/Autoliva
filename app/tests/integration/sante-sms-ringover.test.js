/**
 * Le SMS de rappel aux appels manqués cesse de partir : le tableau de bord
 * doit le dire, et dire quoi faire.
 *
 * Lancé par : npm test
 *
 * Base : mongodb-memory-server. MONGODB_URI est volontairement IGNORÉE : dans
 * ce dépôt elle désigne la PRODUCTION.
 *
 * ── Ce qu'on rejoue ─────────────────────────────────────────────────────────
 *
 * L'histoire réelle du 25/09/2026 : des envois qui aboutissent, puis d'un jour
 * à l'autre des « 403 insufficient permissions » en série, pendant 19 jours,
 * sans que rien ne le signale. Et le piège qui l'a rendue invisible : le
 * journal contenait DÉJÀ des centaines d'échecs attendus (lignes fixes,
 * numéros étrangers), au milieu desquels le vrai basculement ne se voyait pas.
 * Un avertissement qui crie tout le temps ne prévient de rien.
 */

process.env.BRAND = 'autoliva';
/* Valeurs factices : le service de santé ne contacte jamais Ringover, il ne
   fait que constater que le canal est censé être armé. */
process.env.RINGOVER_API_KEY = 'cle-de-test-sans-valeur';
process.env.RINGOVER_SMS_FROM = '+33600000000';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const AbandonedCart = require('../../src/models/AbandonedCart');
const { etatSmsRingover } = require('../../src/services/santeSmsRingover');
const ringoverSms = require('../../src/services/ringoverSms');

let memoire;
const JOUR = 24 * 3600 * 1000;

function accuse(quand, { ok = true, motif = '' } = {}) {
  return {
    canal: 'sms', sens: 'sortant', auto: true, gabarit: 'ringover_accuse',
    statut: ok ? 'envoye' : 'echec', motif, par: 'Système', at: quand,
  };
}

async function semer(communicationsParFiche) {
  await AbandonedCart.deleteMany({});
  let i = 0;
  for (const comms of communicationsParFiche) {
    i += 1;
    await AbandonedCart.create({
      sessionId: `test-sante-sms-${i}`,
      abandonedAt: new Date(),
      phone: `+3361234567${i % 10}`,
      captureSource: 'appel_manque',
      communications: comms,
    });
  }
}

test.before(async () => {
  const uri = process.env.TEST_MONGODB_URI || (memoire = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await AbandonedCart.deleteMany({});
    await mongoose.disconnect();
  }
  if (memoire) await memoire.stop();
});

test('tout va bien : aucun encart, donc aucun bruit', async () => {
  await semer([
    [accuse(new Date(Date.now() - 2 * JOUR)), accuse(new Date(Date.now() - 1 * JOUR))],
    [accuse(new Date(Date.now() - 3 * JOUR))],
  ]);
  const e = await etatSmsRingover();
  assert.equal(e.verdict, 'ok');
  assert.equal(e.echecs, 0);
});

test('le 25/09 rejoué : série de 403 après le dernier succès → alerte', async () => {
  const reussite = new Date(Date.now() - 19 * JOUR);
  const echecs = Array.from({ length: 7 }, (_, k) =>
    accuse(new Date(reussite.getTime() + (k + 1) * JOUR), { ok: false, motif: 'http_403' }));
  await semer([[accuse(reussite), ...echecs.slice(0, 4)], [...echecs.slice(4)]]);

  const e = await etatSmsRingover();
  assert.equal(e.verdict, 'alerte', `verdict inattendu : ${e.verdict} — ${e.message}`);
  assert.equal(e.echecs, 7);
  assert.equal(e.clients, 2, 'le nombre de clients restés sans réponse doit être compté');
  assert.equal(e.motif, 'http_403');
  assert.match(e.message, /Conversations W/, 'le message doit dire quoi faire, pas seulement qu’il y a un problème');
  assert.match(e.message, /RINGOVER_API_KEY/);
  assert.equal(e.jours, 19, 'le nombre de jours sans envoi doit être juste');
});

test('les échecs ANTÉRIEURS au dernier succès ne déclenchent rien', async () => {
  const vieuxEchecs = Array.from({ length: 9 }, (_, k) =>
    accuse(new Date(Date.now() - (10 + k) * JOUR), { ok: false, motif: 'http_403' }));
  await semer([[...vieuxEchecs, accuse(new Date(Date.now() - 1 * JOUR))]]);
  const e = await etatSmsRingover();
  assert.equal(e.verdict, 'ok', 'un incident déjà rattrapé ne doit pas rester affiché');
});

test('un fixe ou un numéro étranger n’est PAS une panne — c’est ce bruit qui avait tout caché', async () => {
  const reussite = new Date(Date.now() - 5 * JOUR);
  const hors = Array.from({ length: 40 }, (_, k) =>
    accuse(new Date(reussite.getTime() + (k + 1) * 3600 * 1000),
      { ok: false, motif: 'destinataire_hors_perimetre' }));
  await semer([[accuse(reussite), ...hors]]);
  const e = await etatSmsRingover();
  assert.equal(e.verdict, 'ok', `40 destinataires hors périmètre ne doivent pas lever d’alerte (${e.message})`);
  assert.equal(e.echecs, 0);
});

test('en dessous du seuil : on prévient sans crier', async () => {
  const reussite = new Date(Date.now() - 3 * JOUR);
  await semer([[
    accuse(reussite),
    accuse(new Date(reussite.getTime() + JOUR), { ok: false, motif: 'reseau' }),
    accuse(new Date(reussite.getTime() + 2 * JOUR), { ok: false, motif: 'reseau' }),
  ]]);
  const e = await etatSmsRingover();
  assert.equal(e.verdict, 'attention');
  assert.match(e.message, /injoignable/);
});

test('crédits épuisés : le message nomme la vraie cause', async () => {
  const reussite = new Date(Date.now() - 4 * JOUR);
  const ko = Array.from({ length: 6 }, (_, k) =>
    accuse(new Date(reussite.getTime() + (k + 1) * 3600 * 1000), { ok: false, motif: 'credits_epuises' }));
  await semer([[accuse(reussite), ...ko]]);
  const e = await etatSmsRingover();
  assert.equal(e.verdict, 'alerte');
  assert.match(e.message, /recharger/i);
});

test('qui peut recevoir le SMS : mesuré sur 1 320 envois réels', () => {
  assert.equal(ringoverSms.peutRecevoir('+33612345678'), true, 'mobile FR métropole');
  assert.equal(ringoverSms.peutRecevoir('+33745000000'), true, 'mobile FR métropole');
  assert.equal(ringoverSms.peutRecevoir('+33148000000'), false, 'ligne fixe');
  assert.equal(ringoverSms.peutRecevoir('+262692000000'), false, 'La Réunion : refusée par Ringover');
  assert.equal(ringoverSms.peutRecevoir('+32470000000'), false, 'Belgique : refusée par Ringover');
});

test('le périmètre s’élargit sans déploiement', () => {
  const avant = process.env.RINGOVER_SMS_PREFIXES;
  process.env.RINGOVER_SMS_PREFIXES = '+336,+337,+262';
  try {
    assert.equal(ringoverSms.peutRecevoir('+262692000000'), true,
      'une nouvelle clé qui ouvrirait les DOM doit se régler par variable');
  } finally {
    if (avant === undefined) delete process.env.RINGOVER_SMS_PREFIXES;
    else process.env.RINGOVER_SMS_PREFIXES = avant;
  }
});

test('hors périmètre : aucun appel à Ringover n’est tenté', async () => {
  const r = await ringoverSms.envoyer({ to: '+33148000000', content: 'test' });
  assert.equal(r.ok, false);
  assert.equal(r.raison, 'destinataire_hors_perimetre');
});
