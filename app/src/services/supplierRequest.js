'use strict';

/**
 * Demande de tarif au fournisseur, prête à copier — Asysum et ses filiales.
 *
 * Avant de chiffrer un devis, le commercial doit demander prix, disponibilité
 * et délai au fournisseur. Chaque famille de pièces a SON interlocuteur, et se
 * tromper de destinataire coûte un aller-retour.
 *
 * ── LE PIÈGE DU ROUTAGE ─────────────────────────────────────────────────────
 *
 * Une « boîte de transfert » n'est PAS une « boîte de vitesses ». Les premières
 * relèvent de Jose Angel (transferts, ponts, Haldex), les secondes de Jose
 * Florin. Un routage qui cherche « boîte » enverrait les 32 demandes de boîte
 * de transfert au mauvais interlocuteur — d'où l'ordre des règles ci-dessous,
 * qui teste « transfert » AVANT « boîte ».
 *
 * ── SUR QUOI ON CLASSE ──────────────────────────────────────────────────────
 *
 * Sur `requested.vehicle`, et sur rien d'autre. Ce champ n'est pas du texte
 * libre : c'est le choix du client dans un menu, 13 valeurs propres sur 466
 * devis. La source de capture, elle, MENT — on trouve en base des demandes de
 * boîte de transfert enregistrées en `landing_moteurs`. Elle ne sert donc que
 * de repli quand le champ est vide.
 *
 * Le message de l'internaute (`requested.message`) est délibérément exclu :
 * classer une pièce d'après une phrase écrite par un client est exactement le
 * genre de raccourci qui envoie un pont chez le spécialiste des moteurs.
 *
 * ── CE QU'ON N'ÉCRIT PAS ────────────────────────────────────────────────────
 *
 * Aucune référence de pièce. Les clients en donnent parfois, mais sans
 * certitude — c'est justement ce qu'ils demandent à faire confirmer. Une
 * référence erronée transmise au fournisseur produit un devis pour la
 * mauvaise pièce.
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
/*  Classement                                                              */
/* ──────────────────────────────────────────────────────────────────────── */

/* Échappement explicite des diacritiques : écrits littéralement, ces
   caractères combinants sont invisibles et se perdent au premier copier-coller. */
function sansAccent(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * ⚠ L'ORDRE EST SIGNIFIANT. « Boîte de transfert » doit tomber dans `ponts`,
 * pas dans `boites` : la règle des transferts passe donc en premier.
 */
const REGLES = [
  { cle: 'ponts', rx: /transfert|haldex|pont|differentiel/ },
  { cle: 'injection', rx: /inject|pompe a injection|diesel/ },
  { cle: 'boites', rx: /boite|vidange/ },
  { cle: 'moteurs', rx: /moteur|culasse|turbo/ },
];

const PAR_SOURCE = {
  landing_ponts: 'ponts',
  landing_boites: 'boites',
  landing_moteurs: 'moteurs',
};

/**
 * Classe le lead, ET DIT SUR QUOI il a été classé.
 *
 * La distinction n'est pas cosmétique. Reconnue dans la pièce demandée, la
 * catégorie est SÛRE — le client a choisi dans un menu. Déduite de la
 * provenance du lead, elle n'est qu'une supposition : c'est le cas des demandes
 * où l'internaute a tapé sa voiture (« Bmw 330 xd ») au lieu de la pièce, et
 * la provenance ment parfois. Le commercial doit voir la différence avant
 * d'envoyer un e-mail au mauvais fournisseur.
 *
 * @returns {{ cle: string|null, sur: 'piece'|'provenance'|'' }}
 */
function categoriser(lead) {
  const piece = sansAccent(lead && lead.requested && lead.requested.vehicle);
  if (piece) {
    const regle = REGLES.find((r) => r.rx.test(piece));
    if (regle) return { cle: regle.cle, sur: 'piece' };
  }
  const parSource = PAR_SOURCE[lead && lead.captureSource];
  if (parSource) return { cle: parSource, sur: 'provenance' };
  return { cle: null, sur: '' };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Rédaction                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

/** Le libellé choisi par le client, sinon une désignation neutre. */
function libellePiece(lead, cleFournisseur) {
  const v = String((lead && lead.requested && lead.requested.vehicle) || '').trim();
  if (v) return v;
  const f = FOURNISSEURS[cleFournisseur];
  return f ? f.libelle : 'Pièce';
}

/**
 * Rédige la demande. Volontairement BRÈVE — c'est la consigne de Killian, et
 * un fournisseur qui traite des dizaines de demandes par jour répond plus vite
 * à trois lignes qu'à un formulaire.
 *
 * @param {object} lead
 * @param {string} cleFournisseur
 * @param {object} [opts]
 * @param {string} [opts.auteur] prénom du commercial, pour la signature
 * @param {string} [opts.vin]    VIN déjà converti, s'il l'a été
 */
function redigerDemande(lead, cleFournisseur, opts = {}) {
  const f = FOURNISSEURS[cleFournisseur];
  if (!f) return null;

  const piece = libellePiece(lead, cleFournisseur);
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
  const objet = 'Demande de tarif - ' + piece + (plaque ? ' - ' + plaque : '');

  return {
    cle: f.cle,
    libelle: f.libelle,
    contact: f.contact,
    email: f.email,
    /* `vinRequis` pilote l'affichage du champ VIN et du lien de conversion. */
    vinRequis: !!f.vin,
    objet,
    corps,
    /* `mailto:` ouvre le client de messagerie déjà rempli — un clic de moins
       que copier/coller, et le commercial garde la main sur l'envoi. */
    /* L'adresse n'est PAS encodée : `@` deviendrait `%40` et certains clients
       de messagerie ouvrent alors un destinataire vide. Seuls l'objet et le
       corps le sont. */
    mailto: 'mailto:' + f.email
      + '?subject=' + encodeURIComponent(objet)
      + '&body=' + encodeURIComponent(corps),
  };
}

/**
 * Prépare les quatre demandes d'un coup.
 *
 * Le front peut ainsi changer de destinataire sans aller-retour serveur, et
 * SURTOUT sans réécrire la formulation en JavaScript : le texte n'a qu'une
 * seule source, ici.
 *
 * @returns {{ suggere: string|null, aRemplir: string, lienVin: string, demandes: object }}
 */
function demandesFournisseur(lead, opts = {}) {
  const demandes = {};
  ORDRE.forEach((cle) => { demandes[cle] = redigerDemande(lead, cle, opts); });
  const { cle, sur } = categoriser(lead);
  return {
    suggere: cle,
    /* 'piece' = certain, 'provenance' = supposition à vérifier. */
    suggereSur: sur,
    aRemplir: A_REMPLIR,
    lienVin: LIEN_VIN,
    demandes,
  };
}

module.exports = {
  FOURNISSEURS, ORDRE, A_REMPLIR, LIEN_VIN,
  categoriser, redigerDemande, demandesFournisseur,
};
