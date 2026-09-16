/**
 * Filtre des allégations non prouvées (src/services/claimFilter.js) — plan de
 * reprise SEO du 14/09/2026, action A3 (e).
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Les phrases testées sont de VRAIES phrases du catalogue (relevées en lecture
 * seule le 14/09/2026) : c'est sur elles que la liste d'expressions a été
 * éprouvée — 13 362 fiches, 0 allégation résiduelle, 0 phrase retirée à tort.
 * Le rendu complet de la fiche est couvert par
 * tests/integration/fiche-produit-rendu.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const cf = require('../../src/services/claimFilter');

const fiche = (sku, months, scalapayActif = false) => cf.contexteFiche({ sku, warranty: { months } }, { scalapayActif });
const DEK = fiche('DEK-18078556779', 24);
const ASY = fiche('ASY-0100214793', 12);
const LANDING = cf.contexteLanding({ scalapayActif: false });

test('familles : le préfixe du SKU décide, sans confondre ALV-BX et les imports Alibaba', () => {
  assert.equal(cf.familleDuSku('DM-81318'), 'DM');
  for (const sku of ['ALV-PT-2462800200', 'ALV-BT-27107505375', 'ALV-MEC-1', 'ALV-CP-1', 'ALV-RD-1']) {
    assert.equal(cf.familleDuSku(sku), 'ALIBABA', sku);
  }
  assert.equal(cf.familleDuSku('ALV-BX-TWP-B7AB26'), 'ALV-BX');
  assert.equal(cf.familleDuSku('  dm-81318 '), 'DM', 'casse et blancs ignorés');
  assert.equal(cf.familleDuSku('0AM 325 025'), 'AUTRES', 'fiche faite main');
  assert.equal(cf.familleDuSku(''), 'AUTRES');
});

test('description masquée : français seulement, jamais DM, interrupteur global', () => {
  const avant = process.env.SHOW_PRODUCT_DESCRIPTION;
  try {
    delete process.env.SHOW_PRODUCT_DESCRIPTION;
    assert.equal(cf.motifDescriptionMasquee({ sku: '0AM 325 025' }, { lang: 'fr' }), null);
    assert.equal(cf.motifDescriptionMasquee({ sku: 'ALV-BX-TWP' }, { lang: 'fr' }), null);
    assert.equal(cf.motifDescriptionMasquee({ sku: '0AM 325 025' }, { lang: 'de' }), 'langue');
    /* Les 6 327 copies distrimotor : la règle porte sur le SKU, pas sur le
       texte — elle couvre aussi celles dont le texte a été retouché. */
    assert.equal(cf.motifDescriptionMasquee({ sku: 'DM-81318' }, { lang: 'fr' }), 'famille:DM');
    /* Alibaba : retenue jusqu'au 16/09/2026, rendue depuis — les pièces sont
       refaites en usine, leur description dit donc vrai (décision 4). */
    assert.equal(cf.motifDescriptionMasquee({ sku: 'ALV-PT-2462800200' }, { lang: 'fr' }), null);
    assert.equal(cf.familleADescriptionMasquee({ sku: 'DM-1' }), 'DM');
    assert.equal(cf.familleADescriptionMasquee({ sku: 'ASY-1' }), null);
    process.env.SHOW_PRODUCT_DESCRIPTION = ' OFF ';
    assert.equal(cf.motifDescriptionMasquee({ sku: '0AM 325 025' }, { lang: 'fr' }), 'interrupteur');
    /* Bouton d'urgence tapé à la main sur Render : les façons courantes de
       dire « coupé » coupent toutes. */
    for (const coupe of ['false', 'FALSE', '0', 'no', 'non']) {
      process.env.SHOW_PRODUCT_DESCRIPTION = coupe;
      assert.equal(cf.motifDescriptionMasquee({ sku: '0AM 325 025' }, { lang: 'fr' }), 'interrupteur', `« ${coupe} » doit couper`);
    }
    for (const allume of ['on', 'true', '1', '']) {
      process.env.SHOW_PRODUCT_DESCRIPTION = allume;
      assert.equal(cf.motifDescriptionMasquee({ sku: '0AM 325 025' }, { lang: 'fr' }), null, `« ${allume} » ne doit rien couper`);
    }
  } finally {
    if (avant === undefined) delete process.env.SHOW_PRODUCT_DESCRIPTION; else process.env.SHOW_PRODUCT_DESCRIPTION = avant;
  }
});

test('politique : toutes les règles actives, aucune levée tant que la preuve manque', () => {
  /* Lever une règle est un choix de Killian, preuve à l'appui : ce test doit
     être modifié EN MÊME TEMPS que claims-policy.json, jamais par accident. */
  const regles = cf.POLITIQUE.regles;
  for (const id of ['iso9001', 'concessionnaires', 'atelierPropre', 'couvertureLaPlusLongue', 'paiementFractionne', 'dureeGarantie']) {
    assert.ok(regles[id], `règle ${id} absente`);
    assert.equal(regles[id].active, true, `règle ${id} désactivée`);
    assert.deepEqual(regles[id].leveePour, [], `règle ${id} levée pour ${regles[id].leveePour}`);
  }
  /* Seules les copies distrimotor restent masquées : Alibaba est rendue le
     16/09/2026. L'ISO 9001 reste filtré tant que le certificat de l'usine
     n'est pas en main — c'est « leveePour » qui le lèvera, pas ce test. */
  assert.deepEqual(Object.keys(cf.POLITIQUE.descriptionMasquee).sort(), ['DM']);
});

test('ISO 9001 : chaque tournure du catalogue devient « usine spécialisée »', () => {
  const cas = [
    ['Reconditionnement à zéro kilomètre en usine certifiée ISO 9001 : remplacement systématique des roulements.',
      'Reconditionnement à zéro kilomètre en usine spécialisée : remplacement systématique des roulements.'],
    ['Cette boîte (référence TWP) est reconditionnée en usine selon la norme ISO 9001, puis testée sur banc avant expédition.',
      'Cette boîte (référence TWP) est reconditionnée en usine spécialisée, puis testée sur banc avant expédition.'],
    ['Boîte automatique référence NZE, reconditionnée en usine (norme ISO 9001) et contrôlée sur banc.',
      'Boîte automatique référence NZE, reconditionnée en usine spécialisée et contrôlée sur banc.'],
    ['Reconditionnement à zéro kilomètre en usine ISO 9001 : remplacement systématique.',
      'Reconditionnement à zéro kilomètre en usine spécialisée : remplacement systématique.'],
    ['Boîte manuelle LZY en échange standard, reconstruite à zéro kilomètre (usine ISO 9001), testée sur banc, garantie 2 ans.',
      'Boîte manuelle LZY en échange standard, reconstruite à zéro kilomètre, testée sur banc, garantie 2 ans.'],
    ['Reconditionnement réalisé par un atelier partenaire certifié ISO 9001',
      'Reconditionnement réalisé par un atelier partenaire spécialisé'],
  ];
  for (const [avant, apres] of cas) assert.equal(cf.filtrer(avant, DEK), apres);
});

test('« fournisseur des concessionnaires » disparaît, la phrase reste', () => {
  assert.equal(
    cf.filtrer('Boîte de vitesses manuelle LZY : reconditionnée dans des usines certifiées ISO 9001 qui équipent directement les concessionnaires. Parfaite pour corriger un point dur.', DEK),
    'Boîte de vitesses manuelle LZY : reconditionnée dans des usines spécialisées. Parfaite pour corriger un point dur.'
  );
  assert.equal(
    cf.filtrer('Reconditionnée en usine certifiée ISO 9001 (fournisseur des concessionnaires)', DEK),
    'Reconditionnée en usine spécialisée'
  );
  /* Le concessionnaire cité pour autre chose n'est pas une allégation. */
  const neutre = 'La pré-programmation au VIN est disponible, sans passage obligatoire chez le concessionnaire.';
  assert.equal(cf.filtrer(neutre, DEK), neutre);
});

test('« notre atelier » → « notre partenaire reconditionneur », préposition et accord gardés', () => {
  const cas = [
    ['Le moteur est un diesel 2.3 16v reconditionné dans notre atelier selon les spécifications du constructeur.',
      'Le moteur est un diesel 2.3 16v reconditionné chez notre partenaire reconditionneur selon les spécifications du constructeur.'],
    ['Chaque commande est préparée et contrôlée avant expédition par notre atelier.',
      'Chaque commande est préparée et contrôlée avant expédition par notre partenaire reconditionneur.'],
    ['Le moteur part de nos ateliers sous 3 à 5 jours, sur palette.',
      'Le moteur part de chez nos partenaires reconditionneurs sous 3 à 5 jours, sur palette.'],
    ['Notre atelier spécialisé réalise un reconditionnement complet.',
      'Notre partenaire reconditionneur réalise un reconditionnement complet.'],
    ['Nos ateliers le reconditionnent selon les spécifications constructeur.',
      'Nos partenaires reconditionneurs le reconditionnent selon les spécifications constructeur.'],
    ['Avant de quitter notre atelier, chaque exemplaire est testé.',
      'Avant de quitter l’atelier de notre partenaire reconditionneur, chaque exemplaire est testé.'],
    ['Il a été entièrement démonté dans nos usines certifiées ISO 9001, contrôlé pièce par pièce.',
      'Il a été entièrement démonté chez nos partenaires reconditionneurs, contrôlé pièce par pièce.'],
    ['Au départ de nos ateliers', 'Au départ de chez nos partenaires reconditionneurs'],
  ];
  for (const [avant, apres] of cas) assert.equal(cf.filtrer(avant, ASY), apres);
  /* Un atelier qui n'est pas « le nôtre » reste tel quel. */
  const neutre = 'Livraisons réelles chez nos clients — garages, concessions et ateliers. Contrôlé en atelier.';
  assert.equal(cf.filtrer(neutre, ASY), neutre);
});

test('« de chez » seulement après un mot de mouvement', () => {
  /* ASY-FHZ : « passe entre les mains de chez notre partenaire » ne se dit pas. */
  assert.equal(
    cf.filtrer('Chaque exemplaire passe entre les mains de notre atelier pour un reconditionnement complet.', ASY),
    'Chaque exemplaire passe entre les mains de notre partenaire reconditionneur pour un reconditionnement complet.'
  );
  assert.equal(
    cf.filtrer('Chaque moteur APX reconditionné sort de notre atelier remis à neuf.', ASY),
    'Chaque moteur APX reconditionné sort de chez notre partenaire reconditionneur remis à neuf.'
  );
  assert.equal(
    cf.filtrer('Chaque exemplaire qui sort de notre atelier est reconditionné.', ASY),
    'Chaque exemplaire qui sort de chez notre partenaire reconditionneur est reconditionné.'
  );
});

test('les autres tournures d’atelier « à nous » du catalogue', () => {
  /* ASY-169A5000, ASY-AUA, ASY-XRMA : les trois dernières passaient au travers. */
  assert.equal(
    cf.filtrer('Chaque exemplaire est remis à neuf dans notre réseau d\'ateliers selon le cahier des charges constructeur.', ASY),
    'Chaque exemplaire est remis à neuf chez nos partenaires reconditionneurs selon le cahier des charges constructeur.'
  );
  assert.equal(
    cf.filtrer('Cet échange standard est reconditionné selon les spécifications constructeur dans notre réseau d\'ateliers : chemises remplacées.', ASY),
    'Cet échange standard est reconditionné selon les spécifications constructeur chez nos partenaires reconditionneurs : chemises remplacées.'
  );
  assert.equal(
    cf.filtrer('Autoliva le reconditionne en échange standard dans son atelier, selon les spécifications du constructeur.', ASY),
    'Autoliva le reconditionne en échange standard chez son partenaire reconditionneur, selon les spécifications du constructeur.'
  );
  /* Un réseau d'ateliers PARTENAIRES dit vrai ; l'atelier du garagiste n'est
     pas le nôtre. */
  for (const neutre of [
    'Il est confié à notre réseau d\'ateliers partenaires.',
    'Le garagiste le monte dans son atelier en une journée.',
  ]) assert.equal(cf.filtrer(neutre, ASY), neutre);
});

test('allemand : « unseren Werkstätten » devient « unseren Partnerwerkstätten »', () => {
  /* Légende du gabarit sous la photo de chargement de chaque fiche /de. */
  assert.equal(cf.filtrer('Von unseren Werkstätten aus', ASY), 'Von unseren Partnerwerkstätten aus');
  assert.equal(cf.filtrer('Teil vor Versand in unserer Werkstatt fotografiert', ASY), 'Teil vor Versand in unserer Partnerwerkstatt fotografiert');
  /* La Werkstatt du client reste la sienne. */
  const neutre = 'Sie oder Ihre Werkstatt bauen das Teil ein.';
  assert.equal(cf.filtrer(neutre, ASY), neutre);
});

test('« couverture la plus longue du marché » disparaît', () => {
  assert.equal(
    cf.filtrer("Garantie 2 ans pièces et main-d'œuvre — couverture la plus longue du marché sur ce modèle", fiche('WC-7756', 24)),
    "Garantie 2 ans pièces et main-d'œuvre"
  );
});

test('3x / 4x : retiré tant que Scalapay est coupé, jamais confondu avec un 4x4', () => {
  const wc = fiche('WC-7756', 0);
  /* Proposition finale : on ne retire qu'elle. */
  assert.equal(
    cf.filtrer('Boîte de transfert Mercedes. Reconditionnée 1 490 € TTC, garantie 2 ans, livraison 48-72 h. Échange standard sans caution, paiement en 3× sans frais.', wc),
    'Boîte de transfert Mercedes. Reconditionnée 1 490 € TTC, garantie 2 ans, livraison 48-72 h. Échange standard sans caution.'
  );
  assert.equal(cf.filtrer('Expédition sous 48-72 h en France métropolitaine, paiement en 3× sans frais (496,67 €/mois)', wc),
    'Expédition sous 48-72 h en France métropolitaine');
  /* Phrase entière consacrée au paiement : elle part. */
  assert.equal(cf.filtrer('Oui, le paiement en 3× ou 4× sans frais est disponible pour les commandes de moins de 2 000 €.', wc), '');
  assert.equal(cf.filtrer('Puis-je payer en plusieurs fois ?', wc), '');
  assert.equal(cf.filtrer('Paiement 3× sans frais', wc), '');
  /* Véhicules et modèles : intouchés. */
  for (const neutre of [
    'Compatible avec plusieurs versions 4x4 de Renault Kadjar, Koleos.',
    'BMW Série 1 Série 4 X3 X4. La puissance dépendant de la version.',
    'Ce moteur plusieurs fois récompensé moteur de l’année.',
  ]) assert.equal(cf.filtrer(neutre, wc), neutre);
  /* Scalapay rallumé : la promesse redevient vraie, rien n'est retiré. */
  const avecScalapay = fiche('WC-7756', 0, true);
  assert.equal(cf.filtrer('Paiement 3× sans frais', avecScalapay), 'Paiement 3× sans frais');
});

test('garantie : une durée qui contredit warranty.months est retirée, la bonne reste', () => {
  const texte = 'Garanti 12 mois pièces et main d\'œuvre ; rodage et vidange à 1 000 km nécessaires. Expédition sur palette.';
  assert.equal(cf.filtrer(texte, ASY), texte, '12 mois sur une fiche à 12 mois : conservé');
  assert.equal(cf.filtrer(texte, fiche('ASY-X', 6)), 'Expédition sur palette.', '12 mois sur une fiche à 6 mois : retiré');
  assert.equal(cf.filtrer('Produit reconditionné avec garantie 2 ans.', DEK), 'Produit reconditionné avec garantie 2 ans.', '2 ans = 24 mois');
  /* Fiche sans durée : rien à contredire. */
  assert.equal(cf.filtrer('Produit reconditionné avec garantie 2 ans.', fiche('02E927770AD', 0)), 'Produit reconditionné avec garantie 2 ans.');
  /* La garantie LÉGALE n'est pas une promesse commerciale. */
  const legale = 'La garantie légale de conformité de 2 ans s’applique.';
  assert.equal(cf.filtrer(legale, ASY), legale);
  /* Dans la même phrase, une durée loin du mot « garanti » parle d'autre chose. */
  const loin = 'Garanti 12 mois pièces et main d’œuvre, avec une vidange conseillée au bout de 3 mois d’utilisation.';
  assert.equal(cf.filtrer(loin, ASY), loin);
});

test('page véhicule : toute durée de garantie « en bloc » tombe', () => {
  assert.equal(
    cf.filtrer('Mécatronique Audi A1 reconditionnée (1.0 TSI, 1.2 TFSI) · 1 référence testée(s) sur banc · garantie 24 mois · livraison 24-48h · paiement 3x/4x sans frais.', LANDING),
    'Mécatronique Audi A1 reconditionnée (1.0 TSI, 1.2 TFSI) · 1 référence testée(s) sur banc · livraison 24-48h.'
  );
  assert.equal(cf.filtrer('Mécatronique Audi A1 reconditionnée · garantie | Autoliva', LANDING), 'Mécatronique Audi A1 reconditionnée · garantie | Autoliva');
});

test('HTML : phrases retirées sans casser le balisage', () => {
  const html = '<p>Chaque pont est testé sur banc dans nos ateliers avant expédition.</p>\n\n'
    + '<p>Cette pièce bénéficie d\'une <strong>garantie de 24 mois</strong>, expédiée sous <strong>24 à 48 heures</strong>. '
    + 'Échange standard avec consigne de 30 jours. Paiement en <strong>3x ou 4x sans frais</strong> via Scalapay disponible au checkout.</p>\n\n'
    + '<p>Paiement en <strong>3x ou 4x sans frais</strong> via Scalapay.</p>';
  assert.equal(cf.filtrer(html, LANDING),
    '<p>Chaque pont est testé sur banc chez nos partenaires reconditionneurs avant expédition.</p>\n\n'
    + '<p>Échange standard avec consigne de 30 jours.</p>');
  /* Balise ouverte dans la phrase retirée, fermée dans la suivante : gardée. */
  assert.equal(
    cf.filtrer('<p><strong>Garantie 24 mois. Livraison 24h</strong> partout.</p>', fiche('X-1', 12)),
    '<p><strong>Livraison 24h</strong> partout.</p>'
  );
  /* Deux phrases finales retirées dont les balises se répondent : aucune
     balise perdue, aucun séparateur arraché au milieu d'une balise. */
  assert.equal(
    cf.filtrer('<p>Livraison 24h. <strong>Paiement en 3x sans frais. Ou 4x</strong> sans frais via Scalapay.</p>', LANDING),
    '<p>Livraison 24h.</p>'
  );
  assert.equal(
    cf.filtrer('<p>Livraison 24h. <em>Paiement en 3x sans frais.</em> Retour sous 30 jours.</p>', LANDING),
    '<p>Livraison 24h. Retour sous 30 jours.</p>'
  );
});

test('texte sans allégation : rendu tel quel, à l’octet près', () => {
  const texte = 'La mécatronique est l’organe électro-hydraulique qui pilote la boîte DSG7 DQ200 (réf. 0AM / 0CW).\n\nQuand elle fatigue…  on observe des à-coups.';
  assert.strictEqual(cf.filtrer(texte, DEK), texte);
  const html = '<p>Z17DTR : moteur complet d\'occasion.</p><ul><li><strong>Carburant :</strong> Diesel.</li></ul>';
  assert.strictEqual(cf.filtrer(html, fiche('AUTO-1', 6)), html);
});

test('markdown : une puce vidée disparaît avec sa ligne', () => {
  const md = 'Points forts :\n\n- échange standard\n\n- paiement en 3x sans frais\n\n- garantie 2 ans';
  assert.equal(cf.filtrer(md, fiche('WC-1', 24)), 'Points forts :\n\n- échange standard\n\n- garantie 2 ans');
});

test('allemand : le filet retire toute phrase qui cite ISO 9001', () => {
  assert.equal(
    cf.filtrer('Manuelles Getriebe LZY, generalüberholt auf null Kilometer (ISO 9001 Werk), auf dem Prüfstand getestet. Ohne Pfand im Voraus.', DEK),
    'Ohne Pfand im Voraus.'
  );
});

test('règle levée pour une famille : son texte passe intact, les autres restent filtrés', () => {
  const regle = cf.POLITIQUE.regles.iso9001;
  const avant = regle.leveePour;
  try {
    regle.leveePour = ['DEK'];
    const texte = 'Reconditionnée en usine certifiée ISO 9001.';
    assert.equal(cf.filtrer(texte, fiche('DEK-1', 24)), texte);
    assert.equal(cf.filtrer(texte, fiche('EDN-1', 24)), 'Reconditionnée en usine spécialisée.');
  } finally {
    regle.leveePour = avant;
  }
});

test('fiche : badges, FAQ, meta et points clés passent par le même filtre', () => {
  const produit = {
    sku: 'AUTO-18705387989',
    warranty: { months: 6, text: 'Garantie 6 mois Autoliva.' },
    shortDescription: 'Moteur complet d\'occasion. Contrôlé, garanti 6 mois Autoliva.',
    description: '<p>Couvert par notre <strong>garantie 6 mois</strong>.</p>',
    seo: { metaTitle: '', metaDescription: 'Moteur d\'occasion, paiement en 3× sans frais.' },
    badges: { topLeft: '', condition: 'Occasion', cards: ['Garantie 6 mois', 'Paiement 3× sans frais', 'Norme ISO 9001'] },
    keyPoints: ['Usine certifiée ISO 9001 (fournisseur des concessionnaires)', 'Livraison en Europe'],
    faqs: [
      { question: 'Quelle garantie ?', answer: 'Tous nos moteurs d\'occasion sont garantis 6 mois par Autoliva.' },
      { question: 'Puis-je payer en plusieurs fois ?', answer: 'Oui, le paiement en 3× ou 4× sans frais est disponible.' },
    ],
  };
  const ctx = cf.contexteFiche(produit, { scalapayActif: false });
  const out = cf.filtrerFiche(produit, ctx);
  assert.deepEqual(out.badges.cards, ['Garantie 6 mois']);
  assert.equal(out.seo.metaDescription, 'Moteur d\'occasion.');
  assert.deepEqual(out.keyPoints, ['Usine spécialisée', 'Livraison en Europe']);
  assert.deepEqual(out.faqs.map((f) => f.question), ['Quelle garantie ?']);
  assert.equal(out.description, produit.description);
  assert.notStrictEqual(out, produit, 'copie, jamais l’original');
  assert.deepEqual(produit.badges.cards, ['Garantie 6 mois', 'Paiement 3× sans frais', 'Norme ISO 9001'], 'l’original est intact');
});

test('blocs d’information : même filtre, avec la garantie de CETTE fiche', () => {
  /* Bloc réel « Conditions — Moteurs reconditionnés », partagé par 334 fiches
     ASY et VEGE. Il annonce 1 an : vrai à 12 mois, faux à 24. */
  const bloc = {
    id: 'b1',
    title: 'Conditions — Moteurs reconditionnés',
    html: '<p>Avant expédition, chaque moteur fait l’objet d’un contrôle complet.</p>\n<p>Garantie : 1 an pièces et main d’œuvre.</p>',
  };
  const tout = { id: 'b2', title: 'Paiement', html: '<p>Paiement en 3x ou 4x sans frais via Scalapay.</p>' };
  const groupes = { description_end: [bloc, tout], after_inclusions: [], dedicated_tab: [] };

  const a12 = cf.filtrerFiche({ sku: 'ASY-1', warranty: { months: 12 }, infoBlocksByPosition: groupes }, fiche('ASY-1', 12));
  assert.equal(a12.infoBlocksByPosition.description_end[0].html, bloc.html, '12 mois : le bloc reste tel quel');

  const a24 = cf.filtrerFiche({ sku: 'VEGE-1', warranty: { months: 24 }, infoBlocksByPosition: groupes }, fiche('VEGE-1', 24));
  assert.equal(a24.infoBlocksByPosition.description_end[0].html, '<p>Avant expédition, chaque moteur fait l’objet d’un contrôle complet.</p>',
    '24 mois : la ligne « 1 an » tombe, le reste du bloc demeure');
  assert.equal(a24.infoBlocksByPosition.description_end.length, 1, 'un bloc entièrement fait d’allégations disparaît');
  assert.deepEqual(a24.infoBlocksByPosition.after_inclusions, []);
  assert.equal(groupes.description_end[0].html, bloc.html, 'l’original est intact');
  /* Un bloc déjà vide en admin (titre seul) n'est pas l'œuvre du filtre : il reste. */
  const titreSeul = cf.filtrerBlocsInfo({ description_end: [{ id: 'b3', title: 'À savoir', html: '' }] }, fiche('VEGE-1', 24));
  assert.deepEqual(titreSeul.description_end, [{ id: 'b3', title: 'À savoir', html: '' }]);
});

test('une longue suite de blancs ne fige pas le filtre', () => {
  /* « \s*[—–,]?\s* » était cubique : 2 000 espaces → 1,7 s, 4 000 → 14 s,
     à chaque affichage de la page. */
  const blancs = `<p>Fin.${' '.repeat(3000)}suite</p>`;
  const debut = process.hrtime.bigint();
  cf.filtrer(blancs, LANDING);
  const ms = Number(process.hrtime.bigint() - debut) / 1e6;
  assert.ok(ms < 1000, `${Math.round(ms)} ms pour 3 000 espaces`);
  /* La réécriture fonctionne toujours, avec ou sans tiret ni virgule. */
  assert.equal(cf.filtrer('Garantie 2 ans — la couverture la plus longue du marché.', fiche('ASY-1', 24)), 'Garantie 2 ans.');
  assert.equal(cf.filtrer('Garantie 2 ans, couverture la plus longue du marché.', fiche('ASY-1', 24)), 'Garantie 2 ans.');
});
