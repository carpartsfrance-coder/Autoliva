'use strict';

/**
 * Demande de tarif au fournisseur, prête à copier — Asysum et ses filiales.
 *
 * Avant de chiffrer un devis, le commercial doit demander prix, disponibilité
 * et délai au fournisseur. Chaque famille de pièces a SON interlocuteur.
 *
 * ── LE COMMERCIAL DÉCIDE, PAS LE CODE ───────────────────────────────────────
 *
 * Une première version choisissait le destinataire et le nom de la pièce toute
 * seule, à partir de la demande et du panier. Elle s'est trompée deux fois en
 * production, sur des cas qu'aucune règle raisonnable n'attrapait :
 *
 *   • « Actionneur de boîte de transfert » contient « boîte » mais relève des
 *     transferts, pas des boîtes de vitesses.
 *   • « Kit démarrage Porsche Cayenne Turbo » n'est pas une demande de
 *     turbocompresseur : « Turbo » est un nom de modèle.
 *   • « Clonage mécatronique TCU DSG » contient « mécatronique » mais c'est une
 *     prestation qu'Autoliva réalise elle-même.
 *
 * Killian a tranché : le commercial choisit le destinataire ET saisit la pièce.
 * Le code ne devine plus rien. Il PROPOSE ce que le client a demandé — la
 * saisie du formulaire et les articles du panier — comme raccourcis de saisie,
 * et rédige le message une fois les deux choix faits.
 *
 * La différence est nette : proposer un libellé que le commercial lit et valide
 * n'engage rien ; présélectionner un destinataire qu'il ne relit pas envoie un
 * e-mail au mauvais fournisseur sans que personne ne s'en aperçoive.
 *
 * ── CE QU'ON N'ÉCRIT JAMAIS ─────────────────────────────────────────────────
 *
 * Aucune référence de pièce. Les clients en donnent, mais sans certitude —
 * c'est justement ce qu'ils font confirmer. Une référence erronée transmise au
 * fournisseur produit un devis pour la mauvaise pièce.
 */

const brand = require('../config/brand');

/** Ce que le commercial doit compléter avant d'envoyer, bien visible. */
const A_REMPLIR = '________________';

/** Conversion plaque → VIN, faite à la main par le commercial. */
const LIEN_VIN = 'https://www.mister-auto.com/';

const FOURNISSEURS = {
  moteurs: {
    cle: 'moteurs',
    libelle: 'Moteurs, culasses, turbos',
    contact: 'Agnès',
    email: 'agnes.labbe@asysum.com',
    /* Asysum identifie notre compte par l'e-mail, pas par un numéro client. */
    compte: 'contact@carpartsfrance.fr',
  },
  boites: {
    cle: 'boites',
    libelle: 'Boîtes de vitesses, kits de vidange',
    contact: 'Jose',
    email: 'jose.florin@inter-matic.com',
  },
  injection: {
    cle: 'injection',
    libelle: 'Systèmes d\'injection',
    contact: 'Sergi',
    email: 'serviciodiesel@asysum.com',
  },
  ponts: {
    cle: 'ponts',
    libelle: 'Ponts, différentiels, transferts, Haldex',
    contact: 'Jose Angel',
    email: 'info@intermaticaragon.es',
    /* Seul destinataire à réclamer le VIN. On ne l'a quasiment jamais (1 lead
       sur 466) : le commercial le convertit depuis la plaque avant d'envoyer. */
    vin: true,
  },
};

const ORDRE = ['moteurs', 'boites', 'injection', 'ponts'];

/* ──────────────────────────────────────────────────────────────────────── */
/*  Ce que le client a demandé                                              */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Tout ce dont on dispose sur la demande : le champ du formulaire de devis ET
 * les articles du panier. Les DEUX, jamais l'un à la place de l'autre.
 *
 * Les deux sources sont incomplètes chacune de leur côté :
 *   • 1 006 leads sur 1 568 n'ont QUE des articles de panier.
 *   • Sur 48 leads, le client a tapé sa VOITURE dans le champ du formulaire
 *     (« NISSAN QASHQAI », « BMW X3 ») alors que le panier portait la pièce.
 *
 * Servi tel quel au commercial comme raccourcis de saisie : il clique celui qui
 * correspond, ou écrit autre chose. Rien n'est présélectionné.
 *
 * @returns {string[]} sans doublon, le champ du formulaire d'abord
 */
function piecesDemandees(lead) {
  const v = String((lead && lead.requested && lead.requested.vehicle) || '').trim();
  const articles = ((lead && lead.items) || []).map((i) => i && i.name)
    .filter(Boolean).map((n) => String(n).trim());
  return Array.from(new Set((v ? [v] : []).concat(articles).filter(Boolean)));
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Rédaction                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Rédige la demande. Volontairement BRÈVE — c'est la consigne de Killian, et
 * un fournisseur qui traite des dizaines de demandes par jour répond plus vite
 * à trois lignes qu'à un formulaire.
 *
 * @param {object} lead
 * @param {string} cleFournisseur
 * @param {object} [opts]
 * @param {string} [opts.piece]  pièce saisie par le commercial
 * @param {string} [opts.auteur] prénom du commercial, pour la signature
 * @param {string} [opts.vin]    VIN converti depuis la plaque
 */
function redigerDemande(lead, cleFournisseur, opts = {}) {
  const f = FOURNISSEURS[cleFournisseur];
  if (!f) return null;

  /* JAMAIS le libellé de la catégorie fournisseur en repli : il annoncerait
     « Moteurs, culasses, turbos » à un client qui veut une seule culasse, et
     Agnès croirait qu'on demande trois pièces. Un blanc est plus honnête. */
  const piece = String(opts.piece || '').trim() || A_REMPLIR;
  const plaque = String((lead && lead.requested && lead.requested.plate) || '').trim().toUpperCase();
  const vinLead = String((lead && lead.requested && lead.requested.vin) || '').trim().toUpperCase();
  const vin = String(opts.vin || vinLead || '').trim().toUpperCase();

  const lignes = [];
  lignes.push('Bonjour ' + f.contact + ',');
  lignes.push('');
  lignes.push('Demande client : ' + piece + '.');
  lignes.push('Immatriculation : ' + (plaque || A_REMPLIR));
  /* Le VIN n'apparaît que pour le destinataire qui le réclame : l'ajouter
     partout allongerait le message sans rien apporter. */
  if (f.vin) lignes.push('VIN : ' + (vin || A_REMPLIR));
  if (f.compte) lignes.push('E-mail compte client : ' + f.compte);
  lignes.push('');
  lignes.push('Pouvez-vous m\'indiquer tarif, disponibilité, délai, consigne et garantie ?');
  lignes.push('');
  lignes.push('Merci,');
  lignes.push(String(opts.auteur || '').trim() || 'L\'équipe Autoliva');
  if (String(opts.auteur || '').trim()) lignes.push(brand.NAME || 'Autoliva');

  const corps = lignes.join('\n');
  /* Objet raccourci : les libellés du catalogue montent à 100 caractères
     (« Mécatronique DSG6 DQ250 reconditionnée 02E927770AD / AQ / AJ… ») et un
     objet à rallonge est tronqué par les messageries au pire endroit. Le
     libellé complet reste dans le corps. */
  const pieceCourte = piece.length > 60 ? piece.slice(0, 59).trim() + '…' : piece;
  const objet = 'Demande de tarif - ' + pieceCourte + (plaque ? ' - ' + plaque : '');

  return {
    cle: f.cle,
    libelle: f.libelle,
    contact: f.contact,
    email: f.email,
    /* `vinRequis` pilote l'affichage du champ VIN et du lien de conversion. */
    vinRequis: !!f.vin,
    objet,
    corps,
    /* L'adresse n'est PAS encodée : `@` deviendrait `%40` et certains clients
       de messagerie ouvrent alors un destinataire vide. Seuls l'objet et le
       corps le sont. */
    mailto: 'mailto:' + f.email
      + '?subject=' + encodeURIComponent(objet)
      + '&body=' + encodeURIComponent(corps),
  };
}

/**
 * Prépare les quatre demandes d'un coup, avec la pièce laissée en blanc.
 *
 * Le front peut ainsi changer de destinataire sans aller-retour serveur, et
 * SURTOUT sans réécrire la formulation en JavaScript : le texte n'a qu'une
 * seule source, ici. La pièce et le VIN sont injectés côté navigateur, à la
 * place des blancs.
 *
 * @returns {{ suggestions: string[], aRemplir: string, lienVin: string, demandes: object }}
 */
function demandesFournisseur(lead, opts = {}) {
  const demandes = {};
  ORDRE.forEach((cle) => { demandes[cle] = redigerDemande(lead, cle, opts); });
  return {
    /* Raccourcis de saisie, pas une présélection : rien n'est appliqué tant que
       le commercial n'a pas cliqué. */
    suggestions: piecesDemandees(lead),
    aRemplir: A_REMPLIR,
    lienVin: LIEN_VIN,
    demandes,
  };
}

module.exports = {
  FOURNISSEURS, ORDRE, A_REMPLIR, LIEN_VIN,
  piecesDemandees, redigerDemande, demandesFournisseur,
};
