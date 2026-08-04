/**
 * Tests unitaires — routage et rédaction des demandes fournisseur.
 *
 * Lancé par : npm test  (aucune base de données requise)
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  categoriser, redigerDemande, demandesFournisseur, FOURNISSEURS, A_REMPLIR,
} = require('../../src/services/supplierRequest');

const lead = (vehicle, extra = {}) => Object.assign({
  requested: Object.assign({ vehicle, plate: 'AB-123-CD', vin: '', ref: '', message: '' }, extra.requested || {}),
}, extra);

test('routage vers le bon interlocuteur Asysum', async (t) => {
  await t.test('une boîte de TRANSFERT va chez Jose Angel, pas chez Jose Florin', () => {
    /* Le piège central : « boîte de transfert » contient le mot « boîte » mais
       relève des transferts. 32 demandes en base sont dans ce cas. */
    const r = categoriser(lead('Boîte de transfert reconditionné(e) — échange standard'));
    assert.equal(r.cle, 'ponts');
    assert.equal(r.sur, 'piece');
    assert.equal(FOURNISSEURS[r.cle].email, 'info@intermaticaragon.es');
  });

  await t.test('une boîte de VITESSES va chez Jose Florin', () => {
    assert.equal(categoriser(lead('Boîte d\'occasion')).cle, 'boites');
    assert.equal(categoriser(lead('Boîte reconditionnée')).cle, 'boites');
    assert.equal(categoriser(lead('Kit de vidange DSG')).cle, 'boites');
    assert.equal(FOURNISSEURS.boites.email, 'jose.florin@inter-matic.com');
  });

  await t.test('ponts, différentiels et Haldex vont chez Jose Angel', () => {
    ['Pont / différentiel arrière reconditionné(e) — échange standard',
      'Pont / différentiel avant reconditionné(e) — échange standard',
      'Boîtier Haldex', 'Differentiel avant'].forEach((v) => {
      assert.equal(categoriser(lead(v)).cle, 'ponts', v);
    });
  });

  await t.test('moteurs, culasses et turbos vont chez Agnès', () => {
    ['Moteur d\'occasion', 'Moteur (état à préciser)', 'Moteur reconditionné',
      'Culasse complète', 'Turbo'].forEach((v) => {
      assert.equal(categoriser(lead(v)).cle, 'moteurs', v);
    });
  });

  await t.test('l’injection va chez Sergi', () => {
    assert.equal(categoriser(lead('Pompe à injection')).cle, 'injection');
    assert.equal(categoriser(lead('Injecteurs')).cle, 'injection');
  });

  await t.test('les accents et la casse ne changent rien', () => {
    assert.equal(categoriser(lead('BOITE DE TRANSFERT')).cle, 'ponts');
    assert.equal(categoriser(lead('différentiel')).cle, 'ponts');
    assert.equal(categoriser(lead('DIFFERENTIEL')).cle, 'ponts');
  });
});

test('articles du panier (1 006 leads sur 1 568 n’ont que ça)', async (t) => {
  const panier = (...noms) => ({ requested: { plate: 'DN186WG' }, items: noms.map((name) => ({ name })) });

  await t.test('la demande nomme L’ARTICLE, jamais la catégorie du fournisseur', () => {
    /* Le défaut signalé par Killian : pour un client qui voulait UNE culasse,
       le message annonçait « Moteurs, culasses, turbos » — le libellé d'Agnès —
       comme si on demandait trois pièces. */
    const l = panier('Culasse Diesel reconditionnée – Mazda CX-5 2.2D Shy – échange standard');
    const d = redigerDemande(l, 'moteurs');
    assert.match(d.corps, /Demande client : Culasse Diesel reconditionnée/);
    assert.doesNotMatch(d.corps, /Moteurs, culasses, turbos/);
  });

  await t.test('une mécatronique DSG va chez Jose, pas chez Agnès', () => {
    /* 348 mécatroniques DSG7 en base : la famille la plus demandée du
       catalogue. Toutes partaient chez Agnès avant ce correctif. */
    assert.equal(categoriser(panier('Mécatronique DSG7 DQ200 (0AM/0CW) reconditionnée (VAG)')).cle, 'boites');
    assert.equal(categoriser(panier('Mécatronique S tronic 0B5 DL501 reconditionnée pour Audi')).cle, 'boites');
    assert.equal(categoriser(panier('TCU reconditionné DSG7 DQ200 0AM/0CW pour VAG')).cle, 'boites');
    assert.equal(categoriser(panier('Calculateur de boîte EDC 6DCT250 / DC4 Continental')).cle, 'boites');
    assert.equal(categoriser(panier('Boîte de vitesses automatique Multitronic 0AW Audi A4')).cle, 'boites');
  });

  await t.test('un actionneur de boîte de TRANSFERT reste chez Jose Angel', () => {
    assert.equal(categoriser(panier('Actionneur de boîte de transfert BMW ATC400 reconditionné')).cle, 'ponts');
    assert.equal(categoriser(panier('Boîte de transfert / renvoi d\'angle Audi 0AV 409 053')).cle, 'ponts');
    assert.equal(categoriser(panier('Pont arrière Haldex reconditionné Audi 0CQ525010H')).cle, 'ponts');
  });

  await t.test('une pompe à injection va chez Sergi, même annoncée en fin de libellé', () => {
    assert.equal(categoriser(panier('Pompe à injection Bosch reconditionnée – échange standard')).cle, 'injection');
    assert.equal(categoriser(panier('CITROEN / PEUGEOT 1,9 TD Rotodiesel 8444B720A - Pompe à injection')).cle, 'injection');
    assert.equal(categoriser(panier('Injecteur Delphi reconditionné')).cle, 'injection');
  });

  await t.test('« Cayenne Turbo » n’est pas une demande de turbo', () => {
    /* Piège réel du catalogue : « turbo » est un nom de modèle Porsche. Sans
       la règle stricte, un kit de démarrage partirait chez Agnès. */
    assert.equal(categoriser(panier('Kit démarrage Porsche Cayenne Turbo 955 4.5 V8')).cle, null);
    assert.equal(categoriser(panier('Turbo reconditionné pour Renault 1.9 dCi')).cle, 'moteurs');
  });

  await t.test('le clonage de mécatronique est un service maison, pas un achat', () => {
    /* Son libellé contient « mécatronique » : sans exception explicite, une
       demande de tarif partirait chez Jose Florin pour une prestation qu'on
       réalise nous-mêmes. */
    assert.equal(categoriser(panier('Clonage mécatronique TCU DSG & S-tronic')).cle, null);
  });

  await t.test('une pièce hors périmètre Asysum n’est pas rattachée de force', () => {
    ['Phares avant d\'origine LED Audi A3 8V2 reconditionnés',
      'PCM reconditionné en échange standard pour Porsche Cayenne 955/957',
      'Accoudoir central cuir noir reconditionné'].forEach((n) => {
      assert.equal(categoriser(panier(n)).cle, null, n);
    });
  });

  await t.test('plusieurs articles sont tous listés, pas seulement le premier', () => {
    const d = redigerDemande(panier('Mécatronique DSG7 DQ200', 'Kit de vidange DSG7'), 'boites');
    assert.match(d.corps, /Mécatronique DSG7 DQ200 \+ Kit de vidange DSG7/);
  });

  await t.test('un panier qui mêle deux familles est signalé, pas tranché en douce', () => {
    const r = categoriser(panier('Mécatronique DSG7 DQ200', 'Pont arrière reconditionné BMW M3'));
    assert.equal(r.sur, 'mixte', 'deux fournisseurs différents : au commercial de trancher');
  });
});

test('le formulaire ne doit pas masquer le panier', async (t) => {
  await t.test('un client qui tape sa VOITURE dans le formulaire n’efface pas l’article', () => {
    /* 48 leads réels : « NISSAN QASHQAI » dans le champ, le vrai pont dans le
       panier. La première version ne lisait que le champ et annonçait un
       modèle de voiture en guise de demande. */
    const l = {
      requested: { vehicle: 'NISSAN QASHQAI', plate: 'DN186WG' },
      items: [{ name: 'Pont arrière reconditionné Renault Kadjar / Nissan Qashqai' }],
    };
    assert.equal(categoriser(l).cle, 'ponts');
    const d = redigerDemande(l, 'ponts');
    assert.match(d.corps, /NISSAN QASHQAI \+ Pont arrière reconditionné/);
  });

  await t.test('un libellé identique des deux côtés n’est pas répété', () => {
    const l = { requested: { vehicle: 'Moteur d\'occasion' }, items: [{ name: 'Moteur d\'occasion' }] };
    const d = redigerDemande(l, 'moteurs');
    assert.match(d.corps, /Demande client : Moteur d'occasion\./);
  });

  await t.test('sans rien de demandé, un blanc à remplir plutôt qu’une invention', () => {
    const d = redigerDemande({ requested: { plate: 'AB-123-CD' } }, 'moteurs');
    assert.match(d.corps, new RegExp('Demande client : ' + A_REMPLIR));
  });

  await t.test('l’objet est raccourci — les libellés catalogue montent à 100 caractères', () => {
    const l = { items: [{ name: 'Mécatronique DSG6 DQ250 reconditionnée 02E927770AD / AQ / AJ 02E325025/ AM / AT / AS avec TCU intégré' }] };
    const d = redigerDemande(l, 'boites');
    assert.ok(d.objet.length < 90, 'objet de ' + d.objet.length + ' caractères');
    /* Le libellé complet reste dans le corps, lui. */
    assert.match(d.corps, /02E325025/);
  });
});

test('classement incertain', async (t) => {
  await t.test('un client qui tape sa VOITURE est classé sur la provenance, et c’est signalé', () => {
    /* 4 demandes en base ressemblent à « Bmw 330 xd » : le client a saisi son
       véhicule, pas la pièce. On se rabat sur la provenance du lead, mais on
       ne fait pas passer cette supposition pour une certitude. */
    const r = categoriser(lead('Bmw 330 xd', { captureSource: 'landing_moteurs' }));
    assert.equal(r.cle, 'moteurs');
    assert.equal(r.sur, 'provenance', 'doit être signalé comme déduit, pas reconnu');
  });

  await t.test('sans pièce ni provenance exploitable, on n’invente pas', () => {
    const r = categoriser(lead('', { captureSource: 'contact' }));
    assert.equal(r.cle, null);
    assert.equal(r.sur, '');
  });

  await t.test('la pièce demandée prime sur la provenance quand elle est reconnue', () => {
    /* Cas réel : des demandes de boîte de transfert sont enregistrées en
       `landing_moteurs`. La provenance ment, la pièce dit vrai. */
    const r = categoriser(lead('Boîte de transfert reconditionné(e)', { captureSource: 'landing_moteurs' }));
    assert.equal(r.cle, 'ponts');
    assert.equal(r.sur, 'piece');
  });
});

test('rédaction du message', async (t) => {
  await t.test('le VIN n’est demandé que par le fournisseur qui le réclame', () => {
    const pont = redigerDemande(lead('Pont / différentiel arrière'), 'ponts', { auteur: 'Charles' });
    assert.match(pont.corps, /VIN : ________________/);
    assert.equal(pont.vinRequis, true);

    const moteur = redigerDemande(lead('Moteur d\'occasion'), 'moteurs', { auteur: 'Charles' });
    assert.doesNotMatch(moteur.corps, /VIN/, 'inutile chez Agnès, ça allongerait le message');
    assert.equal(moteur.vinRequis, false);
  });

  await t.test('le compte client n’apparaît que pour Asysum moteurs', () => {
    assert.match(redigerDemande(lead('Moteur'), 'moteurs').corps, /E-mail compte client : contact@carpartsfrance\.fr/);
    assert.doesNotMatch(redigerDemande(lead('Pont'), 'ponts').corps, /compte client/);
  });

  await t.test('AUCUNE référence de pièce ne fuit dans la demande', () => {
    /* Consigne explicite de Killian : les clients donnent des références dont
       ils ne sont pas sûrs — c'est justement ce qu'ils font confirmer. Une
       référence erronée transmise produirait un devis pour la mauvaise pièce. */
    const l = lead('Moteur d\'occasion', {
      requested: { vehicle: 'Moteur d\'occasion', plate: 'AB-123-CD', ref: 'AUT-2026-08-AF3B67', message: 'je pense que c\'est la ref 03L100036D' },
    });
    const d = redigerDemande(l, 'moteurs');
    assert.doesNotMatch(d.corps, /AUT-2026-08-AF3B67/);
    assert.doesNotMatch(d.corps, /03L100036D/);
    assert.doesNotMatch(d.objet, /AUT-2026/);
  });

  await t.test('un VIN déjà connu remplace le blanc à remplir', () => {
    const d = redigerDemande(lead('Pont'), 'ponts', { vin: 'wvwzzz1kz6w123456' });
    assert.match(d.corps, /VIN : WVWZZZ1KZ6W123456/, 'toujours en majuscules');
    assert.doesNotMatch(d.corps, new RegExp(A_REMPLIR));
  });

  await t.test('une plaque absente laisse un blanc visible, pas une ligne vide', () => {
    const d = redigerDemande(lead('Moteur', { requested: { vehicle: 'Moteur', plate: '' } }), 'moteurs');
    assert.match(d.corps, new RegExp('Immatriculation : ' + A_REMPLIR));
  });

  await t.test('la demande reste courte', () => {
    /* Consigne de Killian : « le plus simple et court possible ». Un
       fournisseur qui traite des dizaines de demandes répond plus vite à un
       message bref — ce test est le garde-fou contre la dérive. */
    const d = redigerDemande(lead('Moteur d\'occasion'), 'moteurs', { auteur: 'Charles' });
    assert.ok(d.corps.split('\n').length <= 12, 'corps de ' + d.corps.split('\n').length + ' lignes');
    assert.ok(d.corps.length < 400, 'corps de ' + d.corps.length + ' caractères');
  });

  await t.test('les cinq questions sont posées en une seule phrase', () => {
    const d = redigerDemande(lead('Moteur'), 'moteurs');
    assert.match(d.corps, /tarif, disponibilité, délai, consigne et garantie/);
  });

  await t.test('l’adresse du mailto n’est pas encodée', () => {
    /* `@` encodé en `%40` ouvre un destinataire vide dans certains clients. */
    const d = redigerDemande(lead('Moteur'), 'moteurs');
    assert.ok(d.mailto.startsWith('mailto:agnes.labbe@asysum.com?'), d.mailto.slice(0, 60));
    assert.match(d.mailto, /[?&]body=/);
  });

  await t.test('la signature reprend le prénom du commercial connecté', () => {
    assert.match(redigerDemande(lead('Moteur'), 'moteurs', { auteur: 'Charles' }).corps, /Merci,\nCharles\n/);
    assert.match(redigerDemande(lead('Moteur'), 'moteurs').corps, /Merci,\nL'équipe Autoliva/);
  });
});

test('préparation pour l’interface', async (t) => {
  await t.test('les quatre destinataires sont fournis d’avance', () => {
    const r = demandesFournisseur(lead('Moteur d\'occasion'), { auteur: 'Charles' });
    /* Le commercial change d'interlocuteur sans aller-retour serveur, et la
       formulation n'existe qu'à un seul endroit. */
    assert.deepEqual(Object.keys(r.demandes).sort(), ['boites', 'injection', 'moteurs', 'ponts']);
    assert.equal(r.suggere, 'moteurs');
    assert.equal(r.suggereSur, 'piece');
    assert.equal(r.aRemplir, A_REMPLIR);
    assert.ok(r.lienVin.startsWith('https://'));
  });

  await t.test('chaque destinataire porte une adresse valide et distincte', () => {
    const r = demandesFournisseur(lead('Moteur'));
    const mails = Object.values(r.demandes).map((d) => d.email);
    assert.equal(new Set(mails).size, 4, 'aucun doublon d’adresse');
    mails.forEach((m) => assert.match(m, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, m));
  });
});
