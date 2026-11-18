/**
 * File de travail commerciale — services/leadWork.js (fonction pure).
 *
 * Les cas reprennent les problèmes constatés le 18/11/2026 :
 *  - 197 demandes Google Ads (landing ponts/transferts) jamais traitées car
 *    exclues de « À traiter » ;
 *  - « Contacté » faisait sortir un client pas encore décidé de la file.
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeWork, comparer, libelleUrgence, libelleUrgenceCourt } = require('../../src/services/leadWork');

/* Mercredi 18/11/2026, 10 h 30 à Paris (UTC+1). */
const NOW = new Date('2026-11-18T09:30:00Z');
const H = 3600000;
const ago = (ms) => new Date(NOW.getTime() - ms);

test('une demande de landing pont / transfert entre dans la file', () => {
  const w = computeWork({ captureSource: 'landing_ponts', phone: '+33608610148', abandonedAt: ago(25 * 60000) }, NOW);
  assert.equal(w.intent, 'opportunity');
  assert.equal(w.stage, 'nouveau');
  assert.equal(w.group, 'nouveaux');
  assert.equal(w.primaryAction, 'call');
  assert.equal(w.canCall, true);
  /* Reçue à 10 h 05 → à rappeler avant 11 h 05. */
  assert.equal(libelleUrgence(w, NOW), 'À rappeler avant 11:05');
});

test('les accusés automatiques ne comptent pas comme une réponse', () => {
  const w = computeWork({
    captureSource: 'landing_ponts', phone: '+33600000000', abandonedAt: ago(2 * H),
    communications: [
      { canal: 'email', auto: true, statut: 'envoye', at: ago(2 * H) },
      { canal: 'sms', auto: true, statut: 'envoye', at: ago(2 * H) },
    ],
  }, NOW);
  assert.equal(w.stage, 'nouveau');
  assert.equal(w.firstHumanAt, null);
});

test('« Contacté » ne fait plus sortir le client de la file', () => {
  const w = computeWork({
    captureSource: 'contact', phone: '0145949020', abandonedAt: ago(5 * 24 * H),
    manualStatus: 'contacted', manualStatusAt: ago(4 * 24 * H),
  }, NOW);
  assert.equal(w.intent, 'opportunity');
  assert.equal(w.stage, 'en_cours');
  /* Sans prochaine action posée : suivi à +2 jours ouvrés → échéance passée.
     Mais PERSONNE n'a promis cette heure : le dossier va dans « À relancer »,
     pas dans le rouge. C'est ce mélange qui avait fabriqué un mur de 168
     lignes rouges que le commercial avait fini par ne plus lire. */
  assert.equal(w.overdue, true);
  assert.equal(w.promesse, false);
  assert.equal(w.group, 'relances');
});

test('un appel sans réponse avec rappel planifié tombe dans « Rappels du jour »', () => {
  const w = computeWork({
    captureSource: 'landing_ponts', phone: '+33768578378', abandonedAt: ago(3 * 24 * H),
    manualStatus: 'contacted', manualStatusAt: ago(H),
    lastCallOutcome: { outcome: 'pas_reponse', at: ago(H), byName: 'Faniry' },
    nextAction: { type: 'callback', dueAt: new Date(NOW.getTime() + 2 * H) },
  }, NOW);
  assert.equal(w.group, 'rappels');
  assert.equal(w.overdue, false);
  assert.equal(w.primaryLabel, 'Rappeler');
});

test('un devis à préparer va dans « Devis à préparer » et ouvre l’atelier', () => {
  const w = computeWork({
    captureSource: 'landing_ponts', phone: '+33679338806', abandonedAt: ago(4 * 24 * H),
    lastCallOutcome: { outcome: 'joint', at: ago(3 * 24 * H) },
    nextAction: { type: 'quote', dueAt: new Date(NOW.getTime() + H) },
  }, NOW);
  assert.equal(w.stage, 'devis_a_faire');
  assert.equal(w.group, 'devis');
  assert.equal(w.primaryAction, 'workshop');
});

test('devis envoyé : relance prévue 3 jours ouvrés après l’envoi', () => {
  const envoi = new Date('2026-11-13T10:00:00Z'); // vendredi 11 h
  const w = computeWork({
    captureSource: 'landing_boites', phone: '+33494492169', email: 'a@b.fr', abandonedAt: envoi,
    engineQuote: { status: 'quote_sent', sentQuotes: [{ sentAt: envoi }] },
  }, NOW);
  assert.equal(w.stage, 'devis_envoye');
  /* ven. 13 → lun. 16, mar. 17, mer. 18 à 11 h → pas encore en retard à 10 h 30. */
  assert.equal(w.dueAt.toISOString(), '2026-11-18T10:00:00.000Z');
  assert.equal(w.group, 'rappels');
});

test('les vieux retards vont dans « Anciens dossiers à reprendre »', () => {
  const w = computeWork({ captureSource: 'landing_ponts', phone: '+33974712020', abandonedAt: new Date('2026-10-09T09:00:00Z') }, NOW);
  assert.equal(w.overdue, true);
  assert.equal(w.group, 'anciens');
  assert.equal(w.primaryAction, 'review');
});

test('les simples passages restent hors de la file, sans bouton « Appeler »', () => {
  for (const captureSource of ['cart_activity', 'newsletter', 'guest_checkout', 'user']) {
    const w = computeWork({ captureSource, phone: '0611223344', email: 'x@y.fr', abandonedAt: ago(H), items: [{ name: 'Boîte' }] }, NOW);
    assert.equal(w.intent, 'weak', captureSource);
    assert.equal(w.group, '', captureSource);
    assert.equal(w.canCall, false, captureSource);
  }
});

test('un panier déjà travaillé par un commercial entre dans la file', () => {
  const w = computeWork({ captureSource: 'cart_activity', email: 'x@y.fr', abandonedAt: ago(H), takenByName: 'Andy' }, NOW);
  assert.equal(w.intent, 'opportunity');
});

test('gagné / perdu / archivé sortent de la file', () => {
  const base = { captureSource: 'landing_ponts', phone: '+33600000000', abandonedAt: ago(H) };
  assert.equal(computeWork({ ...base, manualStatus: 'converted' }, NOW).intent, 'closed');
  assert.equal(computeWork({ ...base, engineQuote: { status: 'acompte_recu' } }, NOW).stage, 'gagne');
  assert.equal(computeWork({ ...base, recoveredOrder: { orderId: 'x' } }, NOW).stage, 'gagne');
  assert.equal(computeWork({ ...base, manualStatus: 'lost' }, NOW).stage, 'perdu');
  assert.equal(computeWork({ ...base, archived: true }, NOW).intent, 'archived');
});

test('tri : l’échéance la plus urgente d’abord, retards récents avant les vieux', () => {
  const a = { id: 'a', work: { group: 'retard', dueAt: ago(2 * H), overdueMinutes: 120 } };
  const b = { id: 'b', work: { group: 'retard', dueAt: ago(3 * 24 * H), overdueMinutes: 3 * 420 } };
  const c = { id: 'c', work: { group: 'retard', dueAt: ago(H), overdueMinutes: 60 } };
  assert.deepEqual([b, c, a].sort(comparer).map((x) => x.id), ['a', 'c', 'b']);
});

test('libellé court pour la liste : retard, heure limite, heure du jour, date', () => {
  const nouveau = computeWork({ captureSource: 'landing_ponts', phone: '+33608610148', abandonedAt: ago(25 * 60000) }, NOW);
  assert.equal(libelleUrgenceCourt(nouveau, NOW), 'Avant 11:05');
  const enRetard = computeWork({ captureSource: 'devis', phone: '0600000000', abandonedAt: ago(3 * H),
    nextAction: { type: 'callback', dueAt: ago(2 * H) } }, NOW);
  assert.match(libelleUrgenceCourt(enRetard, NOW), /^Retard \d+ (min|h)$/);
  const deja = { outcome: 'pas_reponse', at: ago(29 * H) };
  const cetAprem = computeWork({ captureSource: 'devis', phone: '0600000000', abandonedAt: ago(30 * H), lastCallOutcome: deja,
    nextAction: { type: 'callback', dueAt: new Date('2026-11-18T14:00:00Z') } }, NOW);
  assert.equal(libelleUrgenceCourt(cetAprem, NOW), '15:00');
  const vendredi = computeWork({ captureSource: 'devis', phone: '0600000000', abandonedAt: ago(30 * H), lastCallOutcome: deja,
    nextAction: { type: 'callback', dueAt: new Date('2026-11-20T08:30:00Z') } }, NOW);
  assert.equal(libelleUrgenceCourt(vendredi, NOW), 'ven. 20/11');
  assert.equal(libelleUrgenceCourt({}, NOW), '');
});
