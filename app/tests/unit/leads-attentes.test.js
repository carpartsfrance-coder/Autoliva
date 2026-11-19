/**
 * « Attente fournisseur » et « À valider par Killian » (19/11/2026).
 *
 * Demande de Killian : « est-ce que dans les leads à traiter, on devrait
 * mettre de nouveaux statuts ? par exemple en attente devis fournisseur ».
 * Constaté le même jour : une demande de prix déjà envoyée par Lucas à
 * Inter-matic a été renvoyée une heure plus tard pour le même véhicule. Elle
 * n'était écrite que dans une note : rien ne se voyait dans la liste.
 *
 * Vérifié ici :
 *  - les deux attentes ont leur étape, leur onglet et leur libellé ;
 *  - un dossier jamais contacté qui attend le fournisseur va dans son onglet,
 *    pas dans « Non traités » (on répond au client avec le prix) ;
 *  - une attente qui traîne reste dans son onglet (ni « En retard », ni
 *    « Anciens ») ;
 *  - un dossier clos n'y est jamais ;
 *  - la page propose les deux choix (fenêtre « suite » et menu « Reporter »).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { computeWork, GROUPES, TYPES_ACTION, ETAPES, ATTENTES } = require('../../src/services/leadWork');
const { echeance } = require('../../src/controllers/leadWorkController');

const SRC = path.join(__dirname, '..', '..', 'src');
const PAGE = fs.readFileSync(path.join(SRC, 'views', 'admin', 'cart-activity.ejs'), 'utf8');
const FICHE = fs.readFileSync(path.join(SRC, 'views', 'admin', 'partials', 'lead-fiche.ejs'), 'utf8');

/** Jeudi 19/11/2026, heures de Paris (UTC+1). */
const h = (heure, min = 0, jour = 19) => new Date(Date.UTC(2026, 10, jour, heure - 1, min));
const MAINTENANT = h(15);

function demande(nextAction, plus = {}) {
  return Object.assign({
    captureSource: 'devis', email: 'client@example.com', phone: '0612345678',
    abandonedAt: h(9), createdAt: h(9), nextAction,
  }, plus);
}

test('les deux attentes sont des prochaines actions connues (la route les accepte)', () => {
  assert.equal(TYPES_ACTION.wait_supplier, 'Attendre la réponse du fournisseur');
  assert.equal(TYPES_ACTION.to_validate, 'À valider par Killian');
  assert.deepEqual(ATTENTES, { wait_supplier: 'fournisseur', to_validate: 'a_valider' });
  assert.equal(ETAPES.attente_fournisseur.label, 'Attente fournisseur');
  assert.equal(ETAPES.a_valider.label, 'À valider (Killian)');
});

test('les onglets arrivent juste après « Devis à préparer »', () => {
  const cles = GROUPES.map((g) => g.key);
  const i = cles.indexOf('devis');
  assert.deepEqual(cles.slice(i, i + 3), ['devis', 'fournisseur', 'a_valider']);
  GROUPES.filter((g) => ['fournisseur', 'a_valider'].includes(g.key)).forEach((g) => {
    assert.ok(g.court && g.hint, `${g.key} : explication en clair`);
    assert.equal(g.collapsed, false, `${g.key} : onglet ouvert`);
  });
});

test('prix demandé au fournisseur, client pas encore contacté : onglet « Attente fournisseur »', () => {
  const w = computeWork(demande({ type: 'wait_supplier', dueAt: h(9, 30, 20), note: 'Demande de prix envoyée à Asysum' }), MAINTENANT);
  assert.equal(w.intent, 'opportunity');
  assert.equal(w.stage, 'attente_fournisseur');
  assert.equal(w.stageLabel, 'Attente fournisseur');
  assert.equal(w.group, 'fournisseur', 'pas dans « Non traités » : on répond avec le prix');
  assert.equal(w.nextActionLabel, 'Attendre la réponse du fournisseur');
  assert.equal(w.primaryAction, 'email');
  assert.equal(w.primaryLabel, 'Envoyer le devis', 'la réponse arrivée, la suite est le devis');
});

test('attente fournisseur sur un dossier de l’atelier devis : le bouton ouvre l’atelier', () => {
  const w = computeWork(demande({ type: 'wait_supplier', dueAt: h(9, 30, 20) }, { captureSource: 'landing_moteurs' }), MAINTENANT);
  assert.equal(w.group, 'fournisseur');
  assert.equal(w.primaryAction, 'workshop');
  assert.equal(w.primaryLabel, 'Préparer le devis');
});

test('client joignable par téléphone seulement : appeler le client avec le prix', () => {
  const w = computeWork(demande({ type: 'wait_supplier', dueAt: h(9, 30, 20) }, { email: '' }), MAINTENANT);
  assert.equal(w.primaryAction, 'call');
  assert.equal(w.primaryLabel, 'Appeler le client');
});

test('une attente qui traîne reste dans son onglet, ni « En retard » ni « Anciens »', () => {
  /* Réponse attendue il y a deux semaines. */
  const w = computeWork(demande({ type: 'wait_supplier', dueAt: h(9, 30, 5) }, {
    takenByName: 'Lucas', lastManualContactAt: h(10, 0, 4), manualStatus: 'contacted', manualStatusAt: h(10, 0, 4),
  }), MAINTENANT);
  assert.equal(w.overdue, true);
  assert.equal(w.ancien, true);
  assert.equal(w.group, 'fournisseur');
});

test('à valider par Killian : son onglet, et la fiche ouvre le dossier', () => {
  const w = computeWork(demande({ type: 'to_validate', dueAt: h(9, 30, 20), note: 'Devis > 4 000 € HT' }), MAINTENANT);
  assert.equal(w.stage, 'a_valider');
  assert.equal(w.group, 'a_valider');
  assert.equal(w.nextActionLabel, 'À valider par Killian');
  assert.equal(w.primaryAction, 'detail');
  assert.equal(w.primaryLabel, 'Voir le dossier');
});

test('un devis déjà parti qui attend une décision de Killian (remise) est « À valider »', () => {
  const w = computeWork(demande({ type: 'to_validate', dueAt: h(9, 30, 20) }, {
    engineQuote: { status: 'quote_sent', sentQuotes: [{ sentAt: h(11) }] },
  }), MAINTENANT);
  assert.equal(w.stage, 'a_valider');
  assert.equal(w.group, 'a_valider');
});

test('un dossier clos n’est jamais dans ces onglets', () => {
  const perdu = computeWork(demande({ type: 'wait_supplier', dueAt: h(9, 30, 20) }, { manualStatus: 'lost' }), MAINTENANT);
  assert.equal(perdu.stage, 'perdu');
  assert.equal(perdu.group, '');
  const gagne = computeWork(demande({ type: 'to_validate', dueAt: h(9, 30, 20) }, { manualStatus: 'converted' }), MAINTENANT);
  assert.equal(gagne.stage, 'gagne');
  assert.equal(gagne.group, '');
});

test('« demain » pose bien la vérification au prochain jour ouvré, 9 h 30', () => {
  /* Vendredi 20/11 à 15 h → lundi 23/11 à 9 h 30. */
  const vendredi = h(15, 0, 20);
  assert.equal(echeance('demain', vendredi).toISOString(), h(9, 30, 23).toISOString());
});

test('la page propose les deux attentes : fenêtre « suite », menu « Reporter », onglets', () => {
  assert.ok(PAGE.includes("['wait_supplier', 'Attente fournisseur']"), 'choix dans la fenêtre « suite »');
  assert.ok(PAGE.includes("['to_validate', 'À valider par Killian']"), 'choix dans la fenêtre « suite »');
  assert.ok(PAGE.includes("fournisseur: 'Attente fournisseur'") && PAGE.includes("a_valider: 'À valider'"), 'noms courts des onglets');
  assert.ok(PAGE.includes("yellow: 'bg-yellow-100 text-yellow-800'") && PAGE.includes("rose: 'bg-rose-100 text-rose-800'"), 'couleurs des compteurs');
  assert.ok(FICHE.includes('data-type="wait_supplier"'), 'report en un clic « Prix demandé au fournisseur »');
  assert.ok(FICHE.includes('data-type="to_validate"'), 'report en un clic « À valider par Killian »');
});
