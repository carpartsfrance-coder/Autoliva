'use strict';

/**
 * Lexique « pièce » — adapte le vocabulaire du devis (PDF + emails) selon la
 * catégorie du lead, dérivée du captureSource :
 *   - 'moteur' (masculin)                     → landing_moteurs
 *   - 'boite'  (féminin)                      → landing_boites
 *   - 'pont'   (générique « pièce », féminin) → landing_ponts
 *     (ponts, différentiels ET boîtes de transfert : trois pièces de genres
 *      différents → on parle de « la pièce » partout, naturel et toujours juste.)
 *
 * Gère le genre (le moteur / la boîte / la pièce, ce/cette, vendu/vendue…) et
 * les termes de contrôle spécifiques (banc d'essai/compression pour un moteur,
 * passage des rapports/mécatronique pour une boîte, jeu/denture/étanchéité pour
 * un pont ou une boîte de transfert). Tout le reste (prix, marge, TVA,
 * garantie) reste géré par la logique existante, identique partout.
 */

/** Sources de leads « tunnel devis » (landing pages). */
const LEAD_SOURCES = ['landing_moteurs', 'landing_boites', 'landing_ponts'];

/** captureSource → catégorie de lexique. SEUL point de dérivation du code. */
function leadCategoryFromSource(src) {
  if (src === 'landing_boites') return 'boite';
  if (src === 'landing_ponts') return 'pont';
  return 'moteur';
}

function partLexicon(category) {
  const b = category === 'boite';
  if (category === 'pont') {
    return {
      category: 'pont',

      // noms + genre (générique « pièce » — couvre pont, différentiel, transfert)
      noun: 'pièce',
      nounCap: 'Pièce',
      leNoun: 'la pièce',
      duNoun: 'de la pièce',
      votreNoun: 'votre pièce',
      proposeNoun: 'de la pièce proposée',

      // titres / libellés
      devisSubject: 'Devis pont / boîte de transfert',
      headerLabel: 'Pont & transfert',
      headerLabelReconditionne: 'Pièce reconditionnée',
      reserveTitle: 'POUR RÉSERVER CETTE PIÈCE',
      proposedLabel: 'Pièce proposée',
      defaultTitle: 'Pont / différentiel / boîte de transfert',
      defaultCondition: 'Pièce de transmission contrôlée et documentée',
      defaultConditionText: 'Pièce de transmission contrôlée',
      controlTitle: 'Contrôle jeu, denture et étanchéité',
      controlListItem: 'contrôle pièce',
      photosPart: 'Photos de la pièce',
      photosPartExp: 'Photos de la pièce avant expédition',
      blocageStep: 'Blocage\npièce',

      // phrases (accord en genre géré)
      peutEtreVendu: 'la pièce peut être vendue entre-temps',
      reservedSentence: 'Votre pièce est immédiatement réservée.',
      preparedSentence:
        'La pièce est préparée sur palette, protégée, filmée et expédiée avec suivi transporteur. Des photos de préparation peuvent être transmises avant départ.',
      validitySentence:
        'Le devis est valable 7 jours : la pièce restant disponible à la vente, elle peut être cédée à un autre client entre-temps.',
      recondDesc:
        "Pont / boîte de transfert entièrement reconditionné en atelier (roulements, joints et pièces d'usure remplacés), contrôlé avant expédition.",
      occasionDesc:
        'Pièce intégralement contrôlée en atelier avant expédition (jeu, denture, étanchéité).',

      // tokens (accord en genre) pour phrases dynamiques (solde / expédition / acompte / relances)
      article: 'une pièce',
      sourced: 'sourcée',
      controlledPast: 'contrôlée',
      declaredPast: 'déclarée',
      expedie: 'expédiée',
      reserve: 'réservée',
      recu: 'reçue',
      marque: 'marquée',

      // étape de préparation/contrôle (email acompte)
      prepTest: "le contrôle du jeu et de l'étanchéité",

      // items "Inclus dans votre devis" (email devis) — contrôle au banc
      benchTestRecond: 'Banc de contrôle (jeu, denture, étanchéité)',
      benchTestOccasion: 'Contrôle obligatoire (jeu, denture, étanchéité)',

      // contrôle visuel (PDF — liste « Contrôles inclus »)
      visualControl: 'Contrôle visuel denture et carter',

      // échange standard / consigne
      oldNoun: 'votre ancienne pièce',
      sentBack: 'renvoyée',
    };
  }
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
    headerLabelReconditionne: b ? 'Boîte reconditionnée' : 'Moteur reconditionné',
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
      ? 'Le devis est valable 7 jours : la boîte restant disponible à la vente, elle peut être cédée à un autre client entre-temps.'
      : 'Le devis est valable 7 jours : le moteur restant disponible à la vente, il peut être cédé à un autre client entre-temps.',
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
    marque: b ? 'marquée' : 'marqué',

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

    // échange standard / consigne
    oldNoun: b ? 'votre ancienne boîte' : 'votre ancien moteur',
    sentBack: b ? 'renvoyée' : 'renvoyé',
  };
}

module.exports = { partLexicon, leadCategoryFromSource, LEAD_SOURCES };
