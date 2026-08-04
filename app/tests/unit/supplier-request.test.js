/**
 * Tests unitaires — demandes de tarif fournisseur.
 *
 * Lancé par : npm test  (aucune base de données requise)
 *
 * Le classement automatique a été RETIRÉ : le commercial choisit le
 * destinataire et saisit la pièce. Ces tests vérifient donc surtout ce que le
 * code ne doit PAS faire — deviner, inventer, ou laisser fuir une référence.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  piecesDemandees, redigerDemande, demandesFournisseur, FOURNISSEURS, ORDRE, A_REMPLIR,
} = require('../../src/services/supplierRequest');

const lead = (extra = {}) => Object.assign({
  requested: Object.assign({ vehicle: '', plate: 'AB-123-CD', vin: '', ref: '', message: '' }, extra.requested || {}),
}, extra);

test('les quatre interlocuteurs Asysum', async (t) => {
  await t.test('chacun porte une adresse valide et distincte', () => {
    const mails = ORDRE.map((k) => FOURNISSEURS[k].email);
    assert.equal(new Set(mails).size, 4, 'aucun doublon d’adresse');
    mails.forEach((m) => assert.match(m, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, m));
  });

  await t.test('les adresses sont bien celles fournies par Killian', () => {
    assert.equal(FOURNISSEURS.moteurs.email, 'agnes.labbe@asysum.com');
    assert.equal(FOURNISSEURS.boites.email, 'jose.florin@inter-matic.com');
    assert.equal(FOURNISSEURS.injection.email, 'serviciodiesel@asysum.com');
    assert.equal(FOURNISSEURS.ponts.email, 'info@intermaticaragon.es');
  });

  await t.test('seul le contact « ponts » réclame le VIN', () => {
    assert.equal(FOURNISSEURS.ponts.vin, true);
    ['moteurs', 'boites', 'injection'].forEach((k) => assert.ok(!FOURNISSEURS[k].vin, k));
  });
});

test('aucune présélection', async (t) => {
  await t.test('rien n’est deviné : le commercial choisit', () => {
    /* Décision de Killian après deux erreurs en production. Le service ne
       renvoie plus aucune suggestion de destinataire — le seul moyen de
       garantir qu'un e-mail ne parte pas au mauvais interlocuteur. */
    const r = demandesFournisseur(lead({ requested: { vehicle: 'Moteur d\'occasion' } }));
    assert.equal(r.suggere, undefined, 'plus aucun destinataire suggéré');
    assert.equal(r.suggereSur, undefined);
  });

  await t.test('sans pièce saisie, le message porte un blanc visible', () => {
    const d = redigerDemande(lead({ requested: { vehicle: 'Moteur d\'occasion', plate: 'AB-123-CD' } }), 'moteurs');
    assert.match(d.corps, new RegExp('Demande client : ' + A_REMPLIR));
    /* Surtout PAS le libellé de la catégorie : « Moteurs, culasses, turbos »
       ferait croire à Agnès qu'on demande trois pièces. */
    assert.doesNotMatch(d.corps, /Moteurs, culasses, turbos/);
    assert.doesNotMatch(d.corps, /Moteur d'occasion/, 'la pièce ne se remplit pas toute seule');
  });

  await t.test('la pièce saisie par le commercial est reprise telle quelle', () => {
    const d = redigerDemande(lead(), 'moteurs', { piece: 'Culasse Mazda CX-5 2.2D' });
    assert.match(d.corps, /Demande client : Culasse Mazda CX-5 2\.2D\./);
    assert.match(d.objet, /Culasse Mazda CX-5 2\.2D/);
  });
});

test('raccourcis de saisie', async (t) => {
  await t.test('le formulaire ET le panier sont proposés, jamais l’un à la place de l’autre', () => {
    /* Les deux sources sont incomplètes : 1 006 leads sur 1 568 n'ont que des
       articles de panier, et sur 48 leads le client a tapé sa VOITURE dans le
       champ du formulaire pendant que le panier portait la pièce. */
    const l = lead({
      requested: { vehicle: 'NISSAN QASHQAI' },
      items: [{ name: 'Pont arrière reconditionné Renault Kadjar' }],
    });
    assert.deepEqual(piecesDemandees(l), ['NISSAN QASHQAI', 'Pont arrière reconditionné Renault Kadjar']);
  });

  await t.test('un panier seul fournit quand même des raccourcis', () => {
    const l = lead({ items: [{ name: 'Mécatronique DSG7 DQ200' }, { name: 'Kit de vidange DSG7' }] });
    assert.deepEqual(piecesDemandees(l), ['Mécatronique DSG7 DQ200', 'Kit de vidange DSG7']);
  });

  await t.test('un libellé identique des deux côtés n’est proposé qu’une fois', () => {
    const l = lead({ requested: { vehicle: 'Moteur d\'occasion' }, items: [{ name: 'Moteur d\'occasion' }] });
    assert.deepEqual(piecesDemandees(l), ['Moteur d\'occasion']);
  });

  await t.test('un lead sans demande ne propose rien plutôt qu’un libellé creux', () => {
    assert.deepEqual(piecesDemandees(lead()), []);
    assert.deepEqual(piecesDemandees({}), []);
    assert.deepEqual(demandesFournisseur(lead()).suggestions, []);
  });
});

test('rédaction du message', async (t) => {
  await t.test('le VIN n’est demandé que par le fournisseur qui le réclame', () => {
    const pont = redigerDemande(lead(), 'ponts', { piece: 'Pont arrière', auteur: 'Charles' });
    assert.match(pont.corps, new RegExp('VIN : ' + A_REMPLIR));
    assert.equal(pont.vinRequis, true);

    const moteur = redigerDemande(lead(), 'moteurs', { piece: 'Culasse', auteur: 'Charles' });
    assert.doesNotMatch(moteur.corps, /VIN/, 'inutile chez Agnès, ça allongerait le message');
    assert.equal(moteur.vinRequis, false);
  });

  await t.test('le compte client n’apparaît que pour Asysum moteurs', () => {
    assert.match(redigerDemande(lead(), 'moteurs').corps, /E-mail compte client : contact@carpartsfrance\.fr/);
    assert.doesNotMatch(redigerDemande(lead(), 'ponts').corps, /compte client/);
  });

  await t.test('AUCUNE référence de pièce ne fuit dans la demande', () => {
    /* Consigne explicite de Killian : les clients donnent des références dont
       ils ne sont pas sûrs — c'est justement ce qu'ils font confirmer. Une
       référence erronée transmise produirait un devis pour la mauvaise pièce. */
    const l = lead({
      requested: { vehicle: 'Moteur d\'occasion', plate: 'AB-123-CD', ref: 'AUT-2026-08-AF3B67', message: 'je pense que c\'est la ref 03L100036D' },
      items: [{ name: 'Moteur', sku: 'DM-75254' }],
    });
    const d = redigerDemande(l, 'moteurs', { piece: 'Moteur d\'occasion' });
    assert.doesNotMatch(d.corps, /AUT-2026-08-AF3B67/);
    assert.doesNotMatch(d.corps, /03L100036D/);
    assert.doesNotMatch(d.corps, /DM-75254/, 'notre SKU interne n’a rien à faire chez le fournisseur');
    assert.doesNotMatch(d.objet, /AUT-2026/);
  });

  await t.test('un VIN converti remplace le blanc, toujours en majuscules', () => {
    const d = redigerDemande(lead(), 'ponts', { piece: 'Pont', vin: 'wvwzzz1kz6w123456' });
    assert.match(d.corps, /VIN : WVWZZZ1KZ6W123456/);
    assert.doesNotMatch(d.corps, new RegExp(A_REMPLIR));
  });

  await t.test('un VIN déjà présent sur le lead est repris sans ressaisie', () => {
    const l = lead({ requested: { plate: 'AB-123-CD', vin: 'VF1ABCDEF12345678' } });
    assert.match(redigerDemande(l, 'ponts', { piece: 'Pont' }).corps, /VIN : VF1ABCDEF12345678/);
  });

  await t.test('une plaque absente laisse un blanc visible, pas une ligne vide', () => {
    const d = redigerDemande(lead({ requested: { plate: '' } }), 'moteurs', { piece: 'Culasse' });
    assert.match(d.corps, new RegExp('Immatriculation : ' + A_REMPLIR));
  });

  await t.test('la demande reste courte', () => {
    /* Consigne de Killian : « le plus simple et court possible ». Un
       fournisseur qui traite des dizaines de demandes répond plus vite à un
       message bref — ce test est le garde-fou contre la dérive. */
    const d = redigerDemande(lead(), 'moteurs', { piece: 'Culasse Mazda CX-5', auteur: 'Charles' });
    assert.ok(d.corps.split('\n').length <= 12, 'corps de ' + d.corps.split('\n').length + ' lignes');
    assert.ok(d.corps.length < 400, 'corps de ' + d.corps.length + ' caractères');
  });

  await t.test('les cinq questions sont posées en une seule phrase', () => {
    assert.match(redigerDemande(lead(), 'moteurs').corps, /tarif, disponibilité, délai, consigne et garantie/);
  });

  await t.test('l’objet est raccourci — les libellés catalogue montent à 100 caractères', () => {
    const long = 'Mécatronique DSG6 DQ250 reconditionnée 02E927770AD / AQ / AJ 02E325025/ AM / AT / AS avec TCU intégré';
    const d = redigerDemande(lead(), 'boites', { piece: long });
    /* Budget : « Demande de tarif - » (19) + pièce plafonnée à 60 + plaque (12).
       Le plafond porte sur la PIÈCE, seule partie qui peut s'emballer. */
    assert.ok(d.objet.indexOf(long) === -1, 'le libellé entier ne doit pas passer dans l’objet');
    assert.ok(d.objet.length <= 95, 'objet de ' + d.objet.length + ' caractères');
    assert.match(d.objet, /…/, 'la troncature doit se voir');
    assert.match(d.corps, /02E325025/, 'le libellé complet reste dans le corps');
  });

  await t.test('l’adresse du mailto n’est pas encodée', () => {
    /* `@` encodé en `%40` ouvre un destinataire vide dans certains clients. */
    const d = redigerDemande(lead(), 'moteurs', { piece: 'Culasse' });
    assert.ok(d.mailto.startsWith('mailto:agnes.labbe@asysum.com?'), d.mailto.slice(0, 60));
    assert.match(d.mailto, /[?&]body=/);
  });

  await t.test('la signature reprend le prénom du commercial connecté', () => {
    assert.match(redigerDemande(lead(), 'moteurs', { auteur: 'Charles' }).corps, /Merci,\nCharles\n/);
    assert.match(redigerDemande(lead(), 'moteurs').corps, /Merci,\nL'équipe Autoliva/);
  });

  await t.test('un destinataire inconnu ne produit pas de message bancal', () => {
    assert.equal(redigerDemande(lead(), 'pigeon'), null);
    assert.equal(redigerDemande(lead(), ''), null);
  });
});

test('préparation pour l’interface', async (t) => {
  await t.test('les quatre messages sont fournis d’avance, tous avec la pièce en blanc', () => {
    /* Le commercial change d'interlocuteur sans aller-retour serveur, et la
       formulation n'existe qu'à un seul endroit — le front ne fait que
       remplir les blancs. */
    const r = demandesFournisseur(lead({ requested: { plate: 'AB-123-CD' } }), { auteur: 'Charles' });
    assert.deepEqual(Object.keys(r.demandes).sort(), ['boites', 'injection', 'moteurs', 'ponts']);
    Object.values(r.demandes).forEach((d) => {
      assert.match(d.corps, new RegExp('Demande client : ' + A_REMPLIR), d.cle);
    });
    assert.equal(r.aRemplir, A_REMPLIR);
    assert.ok(r.lienVin.startsWith('https://'));
  });

  await t.test('le blanc est une chaîne substituable côté navigateur', () => {
    /* Le front remplace « Demande client : ____ » par la saisie. Si le blanc
       apparaissait ailleurs par accident, il serait remplacé aussi. */
    const d = redigerDemande(lead({ requested: { plate: 'AB-123-CD' } }), 'moteurs');
    assert.equal(d.corps.split(A_REMPLIR).length - 1, 1, 'un seul blanc quand la plaque est connue');
  });
});
