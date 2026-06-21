'use strict';

/**
 * Lexique « pièce » — adapte le vocabulaire du devis (PDF + emails) selon la
 * catégorie du lead, dérivée du captureSource :
 *   - 'moteur' (masculin)  → landing_moteurs
 *   - 'boite'  (féminin)   → landing_boites
 *
 * Gère le genre (le moteur / la boîte, ce/cette, vendu/vendue…) et les termes
 * de contrôle spécifiques (banc d'essai/compression pour un moteur vs passage
 * des rapports/mécatronique pour une boîte). Tout le reste (prix, marge, TVA,
 * garantie) reste géré par la logique existante, identique aux deux.
 */
function partLexicon(category) {
  const b = category === 'boite';
  return {
    category: b ? 'boite' : 'moteur',

    // noms + genre
    noun: b ? 'boîte' : 'moteur',
    nounCap: b ? 'Boîte' : 'Moteur',
    leNoun: b ? 'la boîte' : 'le moteur',
    duNoun: b ? 'de la boîte' : 'du moteur',
    votreNoun: b ? 'votre boîte' : 'votre moteur',
    proposeNoun: b ? 'de la boîte proposée' : 'du moteur proposé',

    // titres / libellés
    devisSubject: b ? 'Devis boîte de vitesse' : "Devis moteur d'occasion",
    headerLabel: b ? 'Boîte de vitesse' : 'Moteur occasion',
    reserveTitle: b ? 'POUR RÉSERVER CETTE BOÎTE' : 'POUR RÉSERVER CE MOTEUR',
    proposedLabel: b ? 'Boîte proposée' : 'Moteur proposé',
    defaultTitle: b ? 'Boîte de vitesse' : "Moteur d'occasion",
    defaultCondition: b ? 'Boîte de vitesse contrôlée et documentée' : "Moteur d'occasion contrôlé et documenté",
    defaultConditionText: b ? 'Boîte de vitesse contrôlée' : "Moteur d'occasion testé",
    controlTitle: b ? 'Contrôle du passage des rapports' : 'Contrôle compression moteur',
    controlListItem: b ? 'contrôle boîte' : 'contrôle moteur',
    photosPart: b ? 'Photos de la boîte' : 'Photos du moteur',
    photosPartExp: b ? 'Photos de la boîte avant expédition' : 'Photos du moteur avant expédition',
    blocageStep: b ? 'Blocage\nboîte' : 'Blocage\nmoteur',

    // phrases (accord en genre géré)
    peutEtreVendu: b ? 'la boîte peut être vendue entre-temps' : 'le moteur peut être vendu entre-temps',
    reservedSentence: b ? 'Votre boîte est immédiatement réservée.' : 'Votre moteur est immédiatement réservé.',
    preparedSentence: b
      ? 'La boîte est préparée sur palette, protégée, filmée et expédiée avec suivi transporteur. Des photos de préparation peuvent être transmises avant départ.'
      : 'Le moteur est préparé sur palette, protégé, filmé et expédié avec suivi transporteur. Des photos de préparation peuvent être transmises avant départ.',
    validitySentence: b
      ? 'Le devis est valable 24h : la boîte restant disponible à la vente, elle peut être cédée à un autre client entre-temps.'
      : 'Le devis est valable 24h : le moteur restant disponible à la vente, il peut être cédé à un autre client entre-temps.',
    recondDesc: b
      ? "Boîte entièrement reconditionnée en atelier (pièces d'usure remplacées, mécatronique contrôlée), contrôlée avant expédition."
      : "Moteur entièrement reconditionné en atelier (pièces d'usure remplacées), contrôlé avant expédition.",
    occasionDesc: b
      ? 'Boîte intégralement contrôlée en atelier avant expédition.'
      : "Moteur intégralement contrôlé sur banc d'essai avant expédition.",

    // tokens (accord en genre) pour phrases dynamiques (solde / expédition / acompte / relances)
    article: b ? 'une boîte' : 'un moteur',
    sourced: b ? 'sourcée' : 'sourcé',
    controlledPast: b ? 'contrôlée' : 'testé',
    declaredPast: b ? 'déclarée' : 'déclaré',
    expedie: b ? 'expédiée' : 'expédié',
    reserve: b ? 'réservée' : 'réservé',
    recu: b ? 'reçue' : 'reçu',

    // étape de préparation/contrôle (email acompte)
    prepTest: b ? 'le contrôle du passage des rapports' : "le passage sur banc d'essai",

    // items "Inclus dans votre devis" (email devis) — contrôle au banc
    benchTestRecond: b
      ? "Banc d'essai (passage des rapports, étanchéité, mécatronique)"
      : "Banc d'essai (compression, étanchéité, endoscopie)",
    benchTestOccasion: b
      ? "Contrôle obligatoire (passage des rapports, étanchéité, mécatronique)"
      : "Banc d'essai obligatoire (compression, étanchéité, endoscopie)",

    // contrôle visuel (PDF — liste « Contrôles inclus »)
    visualControl: b ? 'Contrôle visuel mécatronique et carter' : 'Contrôle visuel par endoscopie',
  };
}

module.exports = { partLexicon };
