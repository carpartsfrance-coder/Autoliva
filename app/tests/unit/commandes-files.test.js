/**
 * Files de traitement des commandes : file, retard, action suivante.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 */

const test = require('node:test');
const assert = require('node:assert');

const cf = require('../../src/services/commandesFiles');

const MAINTENANT = new Date('2026-09-16T12:00:00Z');
const ilYa = (jours, heures = 0) => new Date(MAINTENANT.getTime() - (jours * 24 + heures) * 3600 * 1000);

function commande(over = {}) {
  return {
    status: 'paid',
    orderType: 'standard',
    createdAt: ilYa(0, 2),
    sourcing: { status: 'a_verifier' },
    statusHistory: [],
    shipments: [],
    ...over,
  };
}

test('chaque commande en cours est dans UNE file de travail, et dans « Toutes »', () => {
  const cas = [
    [commande(), ['a_verifier', 'all']],
    [commande({ sourcing: {} }), ['a_verifier', 'all']],
    [commande({ status: 'processing', sourcing: { status: 'a_commander' } }), ['a_commander', 'all']],
    [commande({ status: 'processing', sourcing: { status: 'commandee' } }), ['commandee', 'all']],
    [commande({ status: 'processing', sourcing: { status: 'en_stock' } }), ['expedier', 'all']],
    [commande({ status: 'label_created', sourcing: { status: 'en_stock' } }), ['expedier', 'all']],
    [commande({ status: 'shipped' }), ['transit', 'all']],
    [commande({ status: 'delivered' }), ['transit', 'all']],
    [commande({ status: 'completed' }), ['all']],
    [commande({ status: 'pending_payment' }), ['all']],
    [commande({ status: 'cancelled' }), ['all']],
  ];
  for (const [c, attendu] of cas) assert.deepEqual(cf.files(c), attendu, `${c.status}/${c.sourcing.status}`);
});

test('une étiquette créée sans appro renseignée va dans « À expédier », pas dans « Appro à vérifier »', () => {
  /* 27 commandes en production le 16/09/2026 : leur demander si la pièce est
     en stock n'a pas de sens, l'étiquette est faite. */
  const c = commande({ status: 'label_created', sourcing: { status: 'a_verifier' } });
  assert.equal(cf.approEffectif(c), 'en_stock');
  assert.deepEqual(cf.files(c), ['expedier', 'all']);
  /* Un choix explicite reste respecté. */
  const aCommander = commande({ status: 'label_created', sourcing: { status: 'a_commander' } });
  assert.deepEqual(cf.files(aCommander), ['a_commander', 'all']);
  /* Expédiée ou livrée sans appro renseignée : la pièce est partie, elle était là. */
  for (const status of ['shipped', 'delivered', 'completed']) {
    assert.equal(cf.approEffectif(commande({ status, sourcing: {} })), 'en_stock', status);
  }
});

test('service de clonage seul : pas de file d’appro, « À expédier » une fois cloné', () => {
  const clonage = (over) => commande({ orderType: 'standalone_cloning', status: 'processing', ...over });
  assert.deepEqual(cf.files(clonage({ cloningStatus: 'client_piece_in_transit' })), ['all']);
  assert.equal(cf.actionSuivante(clonage({ cloningStatus: 'cloning_in_progress' })), null);
  assert.deepEqual(cf.files(clonage({ cloningStatus: 'cloning_done' })), ['expedier', 'all']);
  assert.equal(cf.actionSuivante(clonage({ cloningStatus: 'cloning_done' })).besoin, 'etiquette');
});

test('retard : seuil par étape, et le dépassement affiché, pas l’âge', async (sub) => {
  await sub.test('appro à vérifier : 1 jour depuis le paiement', () => {
    const payee = (jours) => commande({ statusHistory: [{ status: 'paid', changedAt: ilYa(jours, 1) }] });
    assert.deepEqual(cf.retard(payee(1), MAINTENANT), { enRetard: false, jours: 0 });
    assert.deepEqual(cf.retard(payee(3), MAINTENANT), { enRetard: true, jours: 2 });
  });

  await sub.test('commandée : le délai annoncé au fournisseur, 7 jours par défaut', () => {
    const cmd = (jours, expectedDays) => commande({ status: 'processing', sourcing: { status: 'commandee', orderedAt: ilYa(jours, 1), expectedDays } });
    assert.equal(cf.retard(cmd(6), MAINTENANT).enRetard, false);
    assert.deepEqual(cf.retard(cmd(9), MAINTENANT), { enRetard: true, jours: 2 });
    assert.deepEqual(cf.retard(cmd(9, 5), MAINTENANT), { enRetard: true, jours: 4 });
  });

  await sub.test('expédiée depuis 8 jours, seuil 6 : « Retard 2j »', () => {
    const c = commande({ status: 'shipped', statusHistory: [{ status: 'paid', changedAt: ilYa(20) }, { status: 'shipped', changedAt: ilYa(8, 1) }] });
    assert.deepEqual(cf.retard(c, MAINTENANT), { enRetard: true, jours: 2 });
  });

  await sub.test('étiquette non partie depuis 2 jours : retard 1j ; sans historique, la date de l’envoi saisi', () => {
    const c = commande({ status: 'label_created', shipments: [{ trackingNumber: 'X', createdAt: ilYa(2, 1) }] });
    assert.deepEqual(cf.retard(c, MAINTENANT), { enRetard: true, jours: 1 });
  });

  await sub.test('en stock, livrée, annulée : jamais en retard', () => {
    for (const c of [
      commande({ status: 'processing', sourcing: { status: 'en_stock' }, createdAt: ilYa(40) }),
      commande({ status: 'delivered', createdAt: ilYa(40) }),
      commande({ status: 'cancelled', createdAt: ilYa(40) }),
    ]) assert.equal(cf.retard(c, MAINTENANT).enRetard, false, c.status);
  });
});

test('action suivante : déduite du statut, puis de l’appro', () => {
  const id = (c) => { const a = cf.actionSuivante(c); return a && (a.id || a.besoin); };
  assert.equal(id(commande()), 'decision');
  assert.equal(id(commande({ sourcing: { status: 'a_commander' } })), 'commandee');
  assert.equal(id(commande({ status: 'processing', sourcing: { status: 'commandee' } })), 'recue');
  assert.equal(id(commande({ status: 'processing', sourcing: { status: 'en_stock' } })), 'etiquette');
  assert.equal(id(commande({ status: 'label_created', shipments: [{ trackingNumber: '1Z999' }] })), 'expediee');
  assert.equal(id(commande({ status: 'shipped' })), 'livree');
  assert.equal(id(commande({ status: 'delivered' })), 'terminer');
  assert.equal(cf.actionSuivante(commande({ status: 'delivered' })).style, 'doux', '« Terminer » est une clôture');
  assert.equal(cf.actionSuivante(commande({ status: 'pending_payment' })), null);
  assert.equal(cf.actionSuivante(commande({ status: 'refunded' })), null);
});

test('« Expédiée » est bloquée sans numéro de suivi d’envoi', () => {
  const sans = commande({ status: 'label_created', shipments: [] });
  assert.equal(cf.actionSuivante(sans).besoin, 'suivi');
  assert.deepEqual(cf.actionsPossibles(sans), []);
  /* L'étiquette de RÉCUPÉRATION d'une pièce à cloner n'est pas un envoi. */
  const recup = commande({ status: 'label_created', shipments: [{ label: 'Récupération clonage', trackingNumber: 'R1' }] });
  assert.equal(cf.actionSuivante(recup).besoin, 'suivi');
  const avec = commande({ status: 'label_created', shipments: [{ label: 'Envoi', trackingNumber: 'JMG1' }] });
  assert.deepEqual(cf.actionsPossibles(avec), ['expediee']);
});

test('livrée avec consigne pas revenue : pas de « Terminer »', () => {
  const c = commande({ status: 'delivered', orderType: 'exchange', returnStatus: 'pending' });
  assert.equal(cf.actionSuivante(c).besoin, 'retour');
  assert.deepEqual(cf.actionsPossibles(c), []);
  const revenue = commande({ status: 'delivered', orderType: 'exchange', returnStatus: 'returned' });
  assert.deepEqual(cf.actionsPossibles(revenue), ['terminer']);
});

test('état et file après l’action : la commande sort de sa file', () => {
  const aVerifier = commande();
  assert.deepEqual(cf.etatApres(aVerifier, 'en_stock'), { status: 'processing', sourcingStatus: 'en_stock' });
  assert.deepEqual(cf.filesApres(aVerifier, 'en_stock'), ['expedier', 'all']);
  assert.deepEqual(cf.filesApres(aVerifier, 'a_commander'), ['a_commander', 'all']);

  const aCommander = commande({ sourcing: { status: 'a_commander' } });
  assert.deepEqual(cf.etatApres(aCommander, 'commandee'), { status: 'processing', sourcingStatus: 'commandee' });

  /* Déjà étiquetée : recevoir la pièce ne la fait pas reculer en préparation. */
  const etiquetee = commande({ status: 'label_created', sourcing: { status: 'commandee' } });
  assert.deepEqual(cf.etatApres(etiquetee, 'recue'), { status: 'label_created', sourcingStatus: 'en_stock' });

  assert.deepEqual(cf.filesApres(commande({ status: 'shipped' }), 'livree'), ['transit', 'all']);
  assert.deepEqual(cf.filesApres(commande({ status: 'delivered' }), 'terminer'), ['all']);
});

test('alerte d’appro : fournisseur en retard, ou appro jamais renseignée — rien d’autre', () => {
  const enRetard = commande({ status: 'processing', sourcing: { status: 'commandee', orderedAt: ilYa(10), expectedDays: 7 } });
  assert.equal(cf.alerteAppro(enRetard, MAINTENANT), 'Fournisseur en retard · 3j');
  assert.equal(cf.alerteAppro(commande(), MAINTENANT), 'Appro non renseignée à la commande');
  assert.equal(cf.alerteAppro(commande({ purchase: { supplier: 'Ovoko PL' } }), MAINTENANT), '');
  /* Une étiquette en retard ne s'annonce pas ici : la pastille de statut le dit. */
  assert.equal(cf.alerteAppro(commande({ status: 'label_created', sourcing: { status: 'en_stock' }, createdAt: ilYa(9) }), MAINTENANT), '');
});

test('compteurs et résumé', () => {
  const commandes = [
    commande({ statusHistory: [{ status: 'paid', changedAt: ilYa(4) }] }),
    commande({ status: 'processing', sourcing: { status: 'en_stock' } }),
    commande({ status: 'label_created', sourcing: { status: 'en_stock' }, statusHistory: [{ status: 'label_created', changedAt: ilYa(3) }] }),
    commande({ status: 'processing', sourcing: { status: 'commandee', orderedAt: ilYa(12), expectedDays: 7 } }),
    commande({ status: 'delivered' }),
  ];
  const c = cf.compter(commandes, MAINTENANT);
  assert.deepEqual(c.a_verifier, { total: 1, enRetard: 1 });
  assert.deepEqual(c.expedier, { total: 2, enRetard: 1 });
  assert.deepEqual(c.commandee, { total: 1, enRetard: 1 });
  assert.deepEqual(c.transit, { total: 1, enRetard: 0 });
  assert.deepEqual(c.all, { total: 5, enRetard: 3 });
  assert.equal(cf.resume(commandes, MAINTENANT), '2 prêtes à expédier · 1 pièce fournisseur en retard');
  assert.equal(cf.resume([], MAINTENANT), '0 prête à expédier · aucun retard fournisseur');
});
