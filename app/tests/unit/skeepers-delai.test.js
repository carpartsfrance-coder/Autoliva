/**
 * Tests unitaires — programmation des demandes d'avis Skeepers.
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Le sujet : Skeepers programme l'envoi à `réception de l'événement + delay`,
 * où `delay` est un nombre entier de JOURS. Ces tests verrouillent le fait qu'on
 * envoie le délai BRUT, sans correction d'ancienneté.
 *
 * ── CE QUE CES TESTS REMPLACENT ─────────────────────────────────────────────
 *
 * Ils vérifiaient l'inverse : que le délai valait l'âge de la commande, pour
 * faire retomber `purchase_date + delay` sur « maintenant ». Cette lecture,
 * assumée comme une hypothèse dans le code, était fausse — et les tests la
 * verrouillaient au lieu de la mettre à l'épreuve.
 *
 * La mesure, sur CP2026-000485 : achat 16/07 13:05, événement poussé le 11/08
 * 07:08 avec `delay: 26`. Attendu selon l'ancienne lecture : 11/08 13:05.
 * Annoncé par le dashboard Skeepers : 06/09 07:08 = réception + 26 j, à la
 * minute près. Une commande d'un mois attendait donc un mois de plus.
 */

const test = require('node:test');
const assert = require('node:assert');

const sk = require('../../src/services/skeepersReviews');

/** Une commande passée il y a `h` heures. */
const ilYAheures = (h) => ({ createdAt: new Date(Date.now() - h * 3600000), number: 'CP-TEST' });
const ilYAjours = (j) => ilYAheures(j * 24);

const HEURE = 3600000;

test('le délai envoyé est le délai brut, jamais l’âge de la commande', async (t) => {
  const delaiInitial = process.env.SKEEPERS_SOLICITATION_DELAY;
  t.after(() => {
    if (delaiInitial === undefined) delete process.env.SKEEPERS_SOLICITATION_DELAY;
    else process.env.SKEEPERS_SOLICITATION_DELAY = delaiInitial;
  });

  await t.test('par défaut : 0, soit un envoi sans attente', () => {
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    assert.equal(sk.delaiSollicitation(), 0);
  });

  await t.test('SKEEPERS_SOLICITATION_DELAY est repris tel quel', () => {
    process.env.SKEEPERS_SOLICITATION_DELAY = '2';
    assert.equal(sk.delaiSollicitation(), 2);
  });

  await t.test('le piège exact de CP2026-000485 : l’ancienneté ne doit RIEN ajouter', () => {
    /* Commande de 26 jours poussée aujourd'hui. L'ancien calcul renvoyait 26 —
       et Skeepers, qui compte depuis la réception, programmait l'e-mail 26 jours
       plus tard, soit le 06/09 pour un clic du 11/08. */
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    [0.1, 2, 26, 85, 179].forEach((j) => {
      const ev = sk.buildPurchaseEvent(ilYAjours(j), { email: 'client@example.com' });
      assert.equal(ev.solicitation_parameters.delay, 0,
        'commande de ' + j + ' jours → delay ' + ev.solicitation_parameters.delay + ' au lieu de 0');
    });
  });

  await t.test('l’avis produit suit son propre délai, sans report non plus', () => {
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    process.env.SKEEPERS_SOLICITATION_DELAY_PRODUCT = '3';
    const ev = sk.buildPurchaseEvent(
      { ...ilYAjours(40), items: [{ productId: 'p1', name: 'Boîte' }] },
      { email: 'client@example.com' }
    );
    assert.equal(ev.solicitation_parameters.delay, 0);
    assert.equal(ev.solicitation_parameters.delay_product, 3);
    delete process.env.SKEEPERS_SOLICITATION_DELAY_PRODUCT;
  });
});

test('la date annoncée à l’admin part de MAINTENANT, pas de l’achat', async (t) => {
  const delaiInitial = process.env.SKEEPERS_SOLICITATION_DELAY;
  t.after(() => {
    if (delaiInitial === undefined) delete process.env.SKEEPERS_SOLICITATION_DELAY;
    else process.env.SKEEPERS_SOLICITATION_DELAY = delaiInitial;
  });

  await t.test('délai 0 → aujourd’hui, quelle que soit l’ancienneté', () => {
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    const ecart = Math.abs(sk.dateEnvoiPrevue().getTime() - Date.now());
    assert.ok(ecart < 5000, 'écart de ' + ecart + ' ms avec l’instant présent');
  });

  await t.test('délai 2 → dans deux jours', () => {
    process.env.SKEEPERS_SOLICITATION_DELAY = '2';
    const attente = sk.dateEnvoiPrevue().getTime() - Date.now();
    assert.ok(Math.abs(attente - 48 * HEURE) < 5000, 'attente de ' + Math.round(attente / HEURE) + ' h');
  });
});

test('garde-fous', async (t) => {
  await t.test('la limite Skeepers est de 6 mois', () => {
    assert.equal(sk.AGE_MAX_JOURS, 180);
    assert.equal(sk.ageEnJours(ilYAjours(180)), 180);
    assert.equal(sk.ageEnJours(ilYAjours(181)), 181, 'au-delà, le contrôleur refuse avant l’envoi');
  });

  await t.test('une commande sans date ne fait pas planter le calcul', () => {
    assert.equal(sk.ageEnJours({}), 0);
    assert.equal(sk.ageEnJours(null), 0);
    assert.ok(sk.dateEnvoiPrevue() instanceof Date);
    assert.ok(sk.delaiSollicitation() >= 0);
  });

  await t.test('une date d’achat dans le futur ne donne pas un délai négatif', () => {
    const futur = { createdAt: new Date(Date.now() + 3 * HEURE) };
    assert.ok(sk.delaiSollicitation() >= 0);
    assert.equal(sk.ageEnJours(futur), 0);
  });
});
