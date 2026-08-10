/**
 * Tests unitaires — programmation des demandes d'avis Skeepers.
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Le sujet : Skeepers programme l'envoi à `purchase_date + delay`. Un délai
 * figé condamne les commandes anciennes à une date d'envoi DÉJÀ PASSÉE, donc à
 * un silence total. Ces tests verrouillent le calcul qui corrige ça.
 */

const test = require('node:test');
const assert = require('node:assert');

const sk = require('../../src/services/skeepersReviews');

/** Une commande passée il y a `n` jours. */
const ilYA = (n) => ({ createdAt: new Date(Date.now() - n * 86400000), number: 'CP-TEST' });

/** Nombre de jours entre aujourd'hui et une date, arrondi au jour. */
const joursDepuisAujourdhui = (d) =>
  Math.round((new Date(d).getTime() - Date.now()) / 86400000);

test('délai de sollicitation calculé sur l’âge de la commande', async (t) => {
  const delaiInitial = process.env.SKEEPERS_SOLICITATION_DELAY;
  t.after(() => {
    if (delaiInitial === undefined) delete process.env.SKEEPERS_SOLICITATION_DELAY;
    else process.env.SKEEPERS_SOLICITATION_DELAY = delaiInitial;
  });

  await t.test('l’envoi tombe aujourd’hui, quel que soit l’âge de la commande', () => {
    /* C'est tout l'enjeu : le commercial clique quand il juge le moment venu.
       Une commande de 85 jours doit partir maintenant, pas à une date de mai. */
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    [0, 3, 30, 85, 180].forEach((age) => {
      assert.equal(joursDepuisAujourdhui(sk.dateEnvoiPrevue(ilYA(age))), 0,
        'commande de ' + age + ' jours');
    });
  });

  await t.test('le délai envoyé à Skeepers vaut bien l’âge de la commande', () => {
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    assert.equal(sk.delaiPourCommande(ilYA(0)), 0);
    assert.equal(sk.delaiPourCommande(ilYA(85)), 85);
  });

  await t.test('SKEEPERS_SOLICITATION_DELAY décale APRÈS le clic, pas après l’achat', () => {
    /* Changement de référentiel assumé : avec 2, le client est sollicité deux
       jours après la décision, que la commande date d'hier ou de trois mois. */
    process.env.SKEEPERS_SOLICITATION_DELAY = '2';
    assert.equal(joursDepuisAujourdhui(sk.dateEnvoiPrevue(ilYA(0))), 2);
    assert.equal(joursDepuisAujourdhui(sk.dateEnvoiPrevue(ilYA(85))), 2);
    assert.equal(sk.delaiPourCommande(ilYA(85)), 87);
  });

  await t.test('une commande du jour n’est pas programmée dans le passé', () => {
    delete process.env.SKEEPERS_SOLICITATION_DELAY;
    assert.ok(sk.delaiPourCommande(ilYA(0)) >= 0);
    assert.ok(sk.ageEnJours({ createdAt: new Date(Date.now() + 3600000) }) >= 0,
      'une date légèrement future ne doit pas donner un âge négatif');
  });

  await t.test('la limite Skeepers est de 6 mois', () => {
    assert.equal(sk.AGE_MAX_JOURS, 180);
    assert.equal(sk.ageEnJours(ilYA(180)), 180);
    assert.equal(sk.ageEnJours(ilYA(181)), 181, 'au-delà, le contrôleur refuse avant l’envoi');
  });

  await t.test('une commande sans date ne fait pas planter le calcul', () => {
    assert.equal(sk.ageEnJours({}), 0);
    assert.equal(sk.ageEnJours(null), 0);
    assert.ok(sk.dateEnvoiPrevue(null) instanceof Date);
  });
});
