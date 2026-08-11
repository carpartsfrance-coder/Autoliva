/**
 * Tests unitaires — programmation des demandes d'avis Skeepers.
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Le sujet : Skeepers programme l'envoi à `purchase_date + delay`, où `delay`
 * est un nombre entier de JOURS. Une échéance calculée dans le passé ne produit
 * aucun e-mail et aucune erreur. Ces tests verrouillent le fait qu'elle tombe
 * TOUJOURS dans le futur.
 */

const test = require('node:test');
const assert = require('node:assert');

const sk = require('../../src/services/skeepersReviews');

/** Une commande passée il y a `h` heures. */
const ilYAheures = (h) => ({ createdAt: new Date(Date.now() - h * 3600000), number: 'CP-TEST' });
const ilYAjours = (j) => ilYAheures(j * 24);

const HEURE = 3600000;

test('l’échéance tombe toujours dans le futur', async (t) => {
  const delaiInitial = process.env.SKEEPERS_SOLICITATION_DELAY;
  t.after(() => {
    if (delaiInitial === undefined) delete process.env.SKEEPERS_SOLICITATION_DELAY;
    else process.env.SKEEPERS_SOLICITATION_DELAY = delaiInitial;
  });

  await t.test('quel que soit l’âge de la commande', () => {
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    [0.1, 2, 25, 85, 179].forEach((j) => {
      const envoi = sk.dateEnvoiPrevue(ilYAjours(j));
      assert.ok(envoi.getTime() > Date.now(),
        'commande de ' + j + ' jours → échéance ' + envoi.toISOString() + ' déjà passée');
    });
  });

  await t.test('le piège exact de CP2026-000199 : achat en soirée, clic 47 min trop tard', () => {
    /* Achetée à 19h22, poussée à 20h09. L'âge en jours PLEINS valait 85, donc
       l'échéance tombait à achat + 85 j = 19h22 le jour même — 47 minutes avant
       le clic. Rien ne partait, et rien ne le signalait. */
    const achat = new Date(Date.now() - (85 * 24 + 1) * HEURE); // 85 j et 1 h
    const envoi = sk.dateEnvoiPrevue({ createdAt: achat });
    assert.ok(envoi.getTime() > Date.now(), 'échéance ' + envoi.toISOString() + ' dans le passé');
    assert.equal(sk.delaiPourCommande({ createdAt: achat }), 86, 'arrondi vers le HAUT attendu');
  });

  await t.test('l’échéance tient dans les 24 h — c’est la limite de l’API', () => {
    /* `delay` s'exprime en jours entiers : on ne peut pas viser l'instant
       présent. La plus petite échéance future tombe à l'heure d'achat, donc
       au plus 24 h après le clic. Le promettre « immédiat » serait faux. */
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    [0.5, 3.3, 85.4].forEach((j) => {
      const attente = sk.dateEnvoiPrevue(ilYAjours(j)).getTime() - Date.now();
      assert.ok(attente > 0 && attente <= 24 * HEURE + 60000,
        'commande de ' + j + ' j → ' + Math.round(attente / HEURE) + ' h d’attente');
    });
  });

  await t.test('SKEEPERS_SOLICITATION_DELAY ajoute des jours APRÈS le clic', () => {
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    const sans = sk.delaiPourCommande(ilYAjours(10));
    process.env.SKEEPERS_SOLICITATION_DELAY = '2';
    assert.equal(sk.delaiPourCommande(ilYAjours(10)), sans + 2);
    /* Et le décalage vaut pour une commande ancienne comme pour une récente. */
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    const sansVieille = sk.delaiPourCommande(ilYAjours(85));
    process.env.SKEEPERS_SOLICITATION_DELAY = '2';
    assert.equal(sk.delaiPourCommande(ilYAjours(85)), sansVieille + 2);
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
    assert.ok(sk.dateEnvoiPrevue(null) instanceof Date);
    assert.ok(sk.delaiPourCommande({}) >= 0);
  });

  await t.test('une date d’achat dans le futur ne donne pas un délai négatif', () => {
    const futur = { createdAt: new Date(Date.now() + 3 * HEURE) };
    assert.ok(sk.delaiPourCommande(futur) >= 0);
    assert.equal(sk.ageEnJours(futur), 0);
  });
});
