'use strict';

/**
 * Catalogue centralisé de TOUS les SMS automatiques du site.
 *
 * Chaque entrée fournit :
 *  - label / category : pour l'affichage back-office
 *  - defaultTemplate  : le texte par défaut, avec des variables {nom}
 *  - vars             : variables disponibles (nom + description)
 *  - example          : valeurs d'exemple pour l'aperçu
 *
 * Le texte réel envoyé est résolu par services/smsSettings.js (qui applique
 * l'éventuel override back-office : activé/désactivé + texte personnalisé).
 *
 * NB : les SMS e-commerce utilisent {brand} (= nom de marque, "CarParts
 * France"). Les SMS moteur affichent volontairement "Autoliva" (façade
 * moteur) et {phoneMoteur} (numéro du commercial moteurs).
 */

const CATALOG = [
  // ─────────── E-COMMERCE ───────────
  {
    key: 'order_confirmation', category: 'E-commerce', label: 'Confirmation de commande',
    defaultTemplate: "{brand} : commande #{orderNumber} confirmee ! Montant : {total}€ TTC. Suivez-la ici : {orderUrl} — Besoin d'aide ? {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['total', 'Montant TTC (ex: 450,00)'], ['orderUrl', 'Lien suivi commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', total: '450,00', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },
  {
    key: 'shipment_tracking', category: 'E-commerce', label: 'Suivi d\'expédition',
    defaultTemplate: "{brand} : votre commande #{orderNumber} est expediee ! {trackingPart} — Delai : 24-72h. Question ? {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['trackingPart', 'Suivi (transporteur + n°/lien)'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', trackingPart: 'Suivi DPD : https://dpd.fr/AB12', phone: '04 65 84 54 88' },
  },
  {
    key: 'delivery_confirmed', category: 'E-commerce', label: 'Livraison confirmée',
    defaultTemplate: "{brand} : votre commande #{orderNumber} a ete livree. Tout est OK ? Repondez a cet SMS ou appelez le {phone}. Merci pour votre confiance !",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', phone: '04 65 84 54 88' },
  },
  {
    key: 'consigne_reminder_soon', category: 'E-commerce', label: 'Rappel retour consigne',
    defaultTemplate: "{brand} : rappel, votre ancienne piece (commande #{orderNumber}) est a retourner avant le {dueDate}. Details : {orderUrl} — {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['dueDate', 'Date limite retour'], ['orderUrl', 'Lien commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', dueDate: '15/07/2026', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },
  {
    key: 'consigne_overdue', category: 'E-commerce', label: 'Consigne en retard',
    defaultTemplate: "{brand} : URGENT — la date de retour consigne pour la commande #{orderNumber} est depassee. Montant du : {amount}€. Contactez-nous : {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['amount', 'Montant consigne dû'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', amount: '150,00', phone: '04 65 84 54 88' },
  },
  {
    key: 'consigne_received', category: 'E-commerce', label: 'Consigne reçue',
    defaultTemplate: "{brand} : nous avons bien recu votre ancienne piece (commande #{orderNumber}). Consigne regularisee. Merci ! Details : {orderUrl}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['orderUrl', 'Lien commande']],
    example: { brand: 'CarParts France', orderNumber: '10234', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc' },
  },
  {
    key: 'cloning_label_sent', category: 'E-commerce', label: 'Clonage — étiquette envoyée',
    defaultTemplate: "{brand} : votre etiquette UPS pour le clonage (commande #{orderNumber}) est prete. Consultez votre email ou : {orderUrl} — {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['orderUrl', 'Lien commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },
  {
    key: 'cloning_piece_received', category: 'E-commerce', label: 'Clonage — pièce reçue',
    defaultTemplate: "{brand} : nous avons recu votre piece pour clonage (commande #{orderNumber}). Programmation en cours, comptez 2-5 jours. Suivi : {orderUrl}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['orderUrl', 'Lien commande']],
    example: { brand: 'CarParts France', orderNumber: '10234', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc' },
  },
  {
    key: 'cloning_done', category: 'E-commerce', label: 'Clonage — terminé',
    defaultTemplate: "{brand} : clonage termine pour la commande #{orderNumber} ! Expedition sous 24-48h. Vous recevrez le suivi par email. Details : {orderUrl}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['orderUrl', 'Lien commande']],
    example: { brand: 'CarParts France', orderNumber: '10234', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc' },
  },
  {
    key: 'cloning_failed', category: 'E-commerce', label: 'Clonage — échoué',
    defaultTemplate: "{brand} : le clonage (commande #{orderNumber}) n'a pas pu aboutir. Nous vous contactons rapidement pour la suite. Appelez-nous : {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', phone: '04 65 84 54 88' },
  },
  {
    key: 'abandoned_cart', category: 'E-commerce', label: 'Panier abandonné',
    defaultTemplate: "{brand} : votre panier vous attend ! Finalisez votre commande ici : {recoveryUrl} — Stock limite. Question ? {phone}",
    vars: [['brand', 'Nom de la marque'], ['recoveryUrl', 'Lien de récupération du panier'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', recoveryUrl: 'https://carpartsfrance.fr/panier/recuperer/xyz', phone: '04 65 84 54 88' },
  },
  {
    key: 'status_change', category: 'E-commerce', label: 'Changement de statut',
    defaultTemplate: "{brand} : commande #{orderNumber} mise a jour → {statusLabel}. Details : {orderUrl} — {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['statusLabel', 'Nouveau statut'], ['orderUrl', 'Lien commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', statusLabel: 'En préparation', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },

  // ─────────── MOTEUR ───────────
  {
    key: 'moteur_ack', category: 'Moteur', label: 'Accusé de réception (devis)',
    defaultTemplate: "Autoliva : demande de devis {quoteRef} bien recue ! Un technicien vous recontacte sous 24h ouvrees (email ou tel). Urgent ? {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['phoneMoteur', 'Téléphone commercial moteurs']],
    example: { quoteRef: 'AUT-2026-06-7AB12', phoneMoteur: '04 65 84 85 39' },
  },
  {
    key: 'moteur_relance_j7', category: 'Moteur', label: 'Relance devis J+7',
    defaultTemplate: "Autoliva : votre devis {quoteRef} (moteur) est toujours d'actualite. Une question ou reserver le moteur ? Appelez {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['phoneMoteur', 'Téléphone commercial moteurs']],
    example: { quoteRef: 'AUT-2026-06-7AB12', phoneMoteur: '04 65 84 85 39' },
  },
  {
    key: 'moteur_relance_j14', category: 'Moteur', label: 'Relance devis J+14 (dernier rappel)',
    defaultTemplate: "Autoliva : dernier rappel pour votre devis {quoteRef}. Sans nouvelle on cloture le dossier. Toujours interesse ? Appelez {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['phoneMoteur', 'Téléphone commercial moteurs']],
    example: { quoteRef: 'AUT-2026-06-7AB12', phoneMoteur: '04 65 84 85 39' },
  },
  {
    key: 'moteur_expedition', category: 'Moteur', label: 'Expédition moteur',
    defaultTemplate: "Autoliva : votre moteur ({quoteRef}) est expedie !{trackingPart} Question ? {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['trackingPart', 'Suivi (transporteur + n° + lien)'], ['phoneMoteur', 'Téléphone commercial moteurs']],
    example: { quoteRef: 'AUT-2026-06-7AB12', trackingPart: ' Suivi DPD : XYZ789', phoneMoteur: '04 65 84 85 39' },
  },
];

const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));

/** Remplace les {variables} d'un template par leurs valeurs. */
function renderTemplate(template, vars) {
  return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (m, k) =>
    (vars && vars[k] != null ? String(vars[k]) : m)
  );
}

function getCatalog() { return CATALOG; }
function getEntry(key) { return BY_KEY.get(key) || null; }
function isKnownKey(key) { return BY_KEY.has(key); }

module.exports = { getCatalog, getEntry, isKnownKey, renderTemplate };
