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
 * Prestations réalisées EN INTERNE : aucune demande fournisseur n'a de sens.
 * Le clonage de mécatronique est un service Autoliva — sans cette exception il
 * partirait chez Jose Florin, puisque son libellé contient « mécatronique ».
 */
const SERVICE_MAISON = /^clonage/;

/**
 * ⚠ L'ORDRE EST SIGNIFIANT, et chaque règle a été confrontée aux 347 articles
 * réellement présents dans les paniers.
 *
 *  1. Les transferts D'ABORD : « boîte de transfert » et « actionneur de boîte
 *     de transfert » contiennent « boîte » mais relèvent de Jose Angel.
 *  2. L'injection avant les boîtes : « CITROEN 1,9 TD Rotodiesel — Pompe à
 *     injection » ne doit pas être happé par une autre famille.
 *  3. Les boîtes couvrent tout l'univers DSG — mécatronique, TCU, calculateur
 *     de boîte, S tronic, Multitronic. Avec 348 mécatroniques DSG7, c'est la
 *     famille la plus demandée du catalogue.
 *  4. Les moteurs en dernier, et « turbo » y est volontairement STRICT :
 *     « Kit démarrage Porsche Cayenne Turbo » n'est pas une demande de
 *     turbocompresseur, c'est un nom de modèle. Seul un libellé qui COMMENCE
 *     par « turbo » compte.
 *
 * `\bpont\b` et non `pont` : sans les limites de mot, « ponts » attraperait
 * aussi « composant », « répondant »…
 */
const REGLES = [
  { cle: 'ponts', rx: /transfert|renvoi d'angle|haldex|\bpont\b|\bponts\b|differentiel/ },
  { cle: 'injection', rx: /injection|injecteur|rotodiesel|roto diesel/ },
  { cle: 'boites', rx: /mecatronique|\bdsg\b|s.?tronic|multitronic|\btcu\b|\btcm\b|boite|vidange/ },
  { cle: 'moteurs', rx: /moteur|culasse|^turbo\b|turbocompresseur/ },
];

const PAR_SOURCE = {
  landing_ponts: 'ponts',
  landing_boites: 'boites',
  landing_moteurs: 'moteurs',
};

/**
 * Tout ce que le client demande : le champ du formulaire ET les articles du
 * panier. Les DEUX, jamais l'un à la place de l'autre.
 *
 * Deux erreurs de la première version, corrigées ici, tenaient à ce choix :
 *
 *   • Les articles du panier étaient ignorés. 1 006 leads sur 1 568 n'ont que
 *     ça — des mécatroniques et des ponts en majorité — et tous retombaient
 *     silencieusement chez Agnès (moteurs).
 *
 *   • `requested.vehicle` primait ABSOLUMENT et masquait le panier. Or sur
 *     48 leads le client y a tapé sa VOITURE (« NISSAN QASHQAI », « BMW X3 »)
 *     pendant que le panier contenait la vraie pièce. Le message annonçait donc
 *     un modèle de voiture en guise de demande.
 *
 * @returns {string[]} sans doublon, le champ du formulaire d'abord
 */
function piecesDemandees(lead) {
  const v = String((lead && lead.requested && lead.requested.vehicle) || '').trim();
  const articles = ((lead && lead.items) || []).map((i) => i && i.name)
    .filter(Boolean).map((n) => String(n).trim());
  const tout = (v ? [v] : []).concat(articles);
  return Array.from(new Set(tout.filter(Boolean)));
}

function familleDe(libelle) {
  const t = sansAccent(libelle);
  if (!t || SERVICE_MAISON.test(t)) return null;
  const regle = REGLES.find((r) => r.rx.test(t));
  return regle ? regle.cle : null;
}

/**
 * Classe le lead, ET DIT SUR QUOI il a été classé.
 *
 * La distinction n'est pas cosmétique :
 *
 *   `piece`      reconnu dans ce que le client demande — sûr.
 *   `provenance` déduit de la landing d'origine — SUPPOSITION. Le client avait
 *                tapé sa voiture (« Bmw 330 xd ») au lieu de la pièce, et la
 *                provenance ment parfois.
 *   `mixte`      le panier mélange des familles (une mécatronique ET un pont) :
 *                deux fournisseurs différents, le commercial doit trancher.
 *   ''           rien de reconnaissable. On n'invente pas : des phares, un
 *                accoudoir ou un PCM Porsche ne relèvent d'AUCUN des quatre
 *                contacts Asysum.
 *
 * @returns {{ cle: string|null, sur: 'piece'|'provenance'|'mixte'|'' }}
 */
function categoriser(lead) {
  const familles = piecesDemandees(lead).map(familleDe).filter(Boolean);
  if (familles.length) {
    const distinctes = Array.from(new Set(familles));
    return { cle: distinctes[0], sur: distinctes.length > 1 ? 'mixte' : 'piece' };
  }
  const parSource = PAR_SOURCE[lead && lead.captureSource];
  if (parSource) return { cle: parSource, sur: 'provenance' };
  return { cle: null, sur: '' };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Rédaction                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Ce qu'on écrit dans « Demande client : … ».
 *
 * JAMAIS le libellé de la catégorie fournisseur. La première version le faisait
 * en repli et annonçait « Moteurs, culasses, turbos » à un client qui voulait
 * une seule culasse : Agnès aurait cru qu'on demandait trois pièces.
 *
 * Un panier peut contenir plusieurs articles ; on les liste tous, sinon la
 * demande porterait sur une partie de la commande.
 */
function libellePiece(lead) {
  const pieces = piecesDemandees(lead);
  if (!pieces.length) return A_REMPLIR;
  return pieces.map((p) => p.trim()).join(' + ');
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

  const piece = libellePiece(lead);
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
     (« Mécatronique DSG6 DQ250 reconditionnée 02E927770AD / AQ / AJ… »), et un
     objet à rallonge est tronqué par les messageries au pire endroit. Le libellé
     complet reste dans le corps. */
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
