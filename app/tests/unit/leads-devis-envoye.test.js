/**
 * « Dès que j'ai terminé l'appel, je crée le devis et je l'envoie — et je
 * crois qu'ici, sur "pour quand", ça fait remonter le lead. »
 *
 * Le commercial note l'appel AVANT d'envoyer : « Client joint → Préparer le
 * devis → Cet après-midi ». Il envoie le devis dans la foulée, à 11 h 30.
 * L'heure tapée restait posée, et `computeWork` lit `nextAction.dueAt` avant
 * tout le reste : à 14 h le dossier remontait EN ROUGE, avec la consigne
 * « Préparer le devis » — un devis parti depuis trois heures.
 *
 * Deux réponses, vérifiées ici :
 *   - l'envoi d'un devis SOLDE l'action qu'il accomplit (rien à changer dans
 *     les habitudes : ça marche même quand il note l'appel avant) ;
 *   - « Devis envoyé » dans la fenêtre, le seul choix sans heure à donner.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { computeWork, libelleUrgenceCourt } = require('../../src/services/leadWork');
const AbandonedCart = require('../../src/models/AbandonedCart');
const { ACTIONS_SOLDEES_PAR_UN_DEVIS, solderActionDevis } = require('../../src/controllers/engineQuoteAdminController');
const { actionApresDevis, DEVIS_ENVOYE } = require('../../src/controllers/leadWorkController');

const SRC = path.join(__dirname, '..', '..', 'src');
const PAGE = fs.readFileSync(path.join(SRC, 'views', 'admin', 'cart-activity.ejs'), 'utf8');
const ATELIER = fs.readFileSync(path.join(SRC, 'controllers', 'engineQuoteAdminController.js'), 'utf8');

/** Jeudi 19/11/2026, heures de Paris (UTC+1). */
const h = (heure, min = 0) => new Date(Date.UTC(2026, 10, 19, heure - 1, min));
const MAINTENANT = h(15);

/** Appelé à 11 h, devis envoyé à 11 h 30. */
function devisParti(nextAction) {
  return {
    captureSource: 'landing_moteurs', phone: '0604164679', takenByName: 'Lucas',
    abandonedAt: h(9), createdAt: h(9),
    lastCallOutcome: { outcome: 'joint', at: h(11) }, lastManualContactAt: h(11),
    engineQuote: { status: 'quote_sent', sentQuotes: [{ sentAt: h(11, 30) }] },
    nextAction,
  };
}

test('l’heure notée avant l’envoi faisait remonter le dossier en rouge', () => {
  /* Le bug, écrit noir sur blanc pour qu'il ne revienne pas. */
  const avant = computeWork(devisParti({ type: 'quote', dueAt: h(14) }), MAINTENANT);
  assert.equal(avant.stage, 'devis_envoye', 'le devis est bien parti');
  assert.equal(avant.dueSource, 'planifiee', 'c’est l’heure tapée qui gagne');
  assert.equal(avant.promesse, true);
  assert.equal(avant.group, 'retard');
  assert.equal(avant.nextActionLabel, 'Préparer le devis', 'une consigne déjà faite');

  /* Soldée, l'action laisse la règle automatique reprendre la main. */
  const apres = computeWork(devisParti({ type: '', dueAt: null }), MAINTENANT);
  assert.equal(apres.dueSource, 'relance_devis');
  assert.equal(apres.promesse, false, 'personne n’a promis la date de relance');
  assert.equal(apres.overdue, false);
  assert.equal(apres.group, 'plus_tard');
  assert.equal(apres.nextActionLabel, 'Relancer le devis');
});

test('un devis solde « Préparer le devis » et « Chercher la pièce », pas une relance voulue', () => {
  /* Depuis le 19/11/2026, il solde aussi « Attente fournisseur » et « À
     valider par Killian » : un devis parti dit que le prix est arrivé et que
     la décision est prise. */
  assert.deepEqual(ACTIONS_SOLDEES_PAR_UN_DEVIS, ['quote', 'sourcing', 'wait_supplier', 'to_validate']);
  /* Une relance posée à la main reste un rendez-vous voulu, même si une
     nouvelle version du devis part entre-temps. */
  ['follow_quote', 'callback', 'payment', 'wait_client'].forEach((t) => {
    assert.ok(!ACTIONS_SOLDEES_PAR_UN_DEVIS.includes(t), `${t} ne doit pas être effacée`);
  });
});

test('le solde se fait côté base, dans le filtre : pas de course entre deux envois', async () => {
  const appels = [];
  const vrai = AbandonedCart.updateOne;
  AbandonedCart.updateOne = (filtre, maj) => { appels.push({ filtre, maj }); return Promise.resolve({ modifiedCount: 1 }); };
  try { await solderActionDevis('653f0c9fd251d246e1608321', 'Lucas'); } finally { AbandonedCart.updateOne = vrai; }

  assert.equal(appels.length, 1);
  /* Le type est DANS le filtre : aucune lecture préalable, donc aucun écart
     possible entre ce qu'on a lu et ce qu'on écrase. */
  assert.deepEqual(appels[0].filtre['nextAction.type'], { $in: ['quote', 'sourcing', 'wait_supplier', 'to_validate'] });
  const posee = appels[0].maj.$set.nextAction;
  assert.equal(posee.type, '');
  assert.equal(posee.dueAt, null);
  assert.equal(posee.setByName, 'Lucas');
});

test('les deux chemins d’envoi de devis soldent l’action', () => {
  /* L'atelier et le devis instantané plaque : si un troisième apparaît un
     jour, ce test le signale. */
  const appels = (ATELIER.match(/await solderActionDevis\(/g) || []).length;
  assert.equal(appels, 2, `solderActionDevis appelé ${appels} fois, attendu 2`);
});

test('« Devis envoyé » pose la relance sans date : elle se déduit, elle ne se promet pas', () => {
  const action = actionApresDevis({ court: 'Lucas' }, MAINTENANT, 'EAT6 reconditionnée 2 390 €');
  assert.equal(action.type, 'follow_quote');
  assert.equal(action.dueAt, null, 'aucune heure promise');
  assert.equal(action.note, 'EAT6 reconditionnée 2 390 €');

  /* Posée sur un dossier, elle donne « Relancer le devis » en ambre. */
  const w = computeWork(devisParti(action), MAINTENANT);
  assert.equal(w.nextActionLabel, 'Relancer le devis');
  assert.equal(w.dueSource, 'relance_devis');
  assert.equal(w.promesse, false);
});

test('même sans devis enregistré, « Devis envoyé » ne produit jamais de rouge', () => {
  /* Devis parti à la main par email : rien dans engineQuote.sentQuotes. La
     file retombe sur le suivi à +2 jours ouvrés, en ambre. */
  const lead = {
    captureSource: 'devis', phone: '0604164679', takenByName: 'Lucas',
    abandonedAt: h(9), createdAt: h(9),
    lastCallOutcome: { outcome: 'joint', at: h(11) }, lastManualContactAt: h(11),
    nextAction: actionApresDevis({ court: 'Lucas' }, MAINTENANT, ''),
  };
  /* Dernier contact jeudi 11 h → suivi dû lundi 11 h. Mardi matin, l'heure
     est passée : ambre « Relancer », jamais rouge. */
  const mardi = new Date(Date.UTC(2026, 10, 24, 9, 0)); // mardi 24/11, 10 h
  const w = computeWork(lead, mardi);
  assert.equal(w.nextActionLabel, 'Relancer le devis');
  assert.equal(w.dueSource, 'suivi');
  assert.equal(w.overdue, true);
  assert.equal(w.promesse, false);
  assert.equal(w.group, 'relances');
  assert.match(libelleUrgenceCourt(w, mardi), /^Relancer · /);
});

test('la fenêtre « Noter l’appel » propose « Devis envoyé », sans demander d’heure', () => {
  assert.equal(DEVIS_ENVOYE, 'devis_envoye');
  assert.ok(PAGE.includes("['devis_envoye', 'Devis envoyé']"), 'le choix manque dans SUITES');
  assert.ok(PAGE.includes("s === 'devis_envoye'"), '« Pour quand ? » doit disparaître sur ce choix');
  assert.ok(PAGE.includes("suite !== 'devis_envoye' && !quand"), 'la validation réclamerait encore une heure');
  assert.ok(PAGE.includes('data-role="aide-devis"'), 'il faut dire ce qui se passe à la place');
  assert.ok(PAGE.includes('relance du devis sera proposée toute seule dans 3 jours ouvrés'));
});
