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
    defaultTemplate: "{brand} : commande #{orderNumber} confirmée ! Montant : {total}€ TTC. Suivez-la ici : {orderUrl} - Besoin d'aide ? {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['total', 'Montant TTC (ex: 450,00)'], ['orderUrl', 'Lien suivi commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', total: '450,00', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },
  {
    key: 'shipment_tracking', category: 'E-commerce', label: 'Suivi d\'expédition',
    defaultTemplate: "{brand} : votre commande #{orderNumber} est expédiée ! {trackingPart} - Délai : 24-72h. Question ? {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['trackingPart', 'Suivi (transporteur + n°/lien)'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', trackingPart: 'Suivi DPD : https://dpd.fr/AB12', phone: '04 65 84 54 88' },
  },
  {
    key: 'delivery_confirmed', category: 'E-commerce', label: 'Livraison confirmée',
    defaultTemplate: "{brand} : votre commande #{orderNumber} a été livrée. Tout est OK ? Répondez à cet SMS ou appelez le {phone}. Merci pour votre confiance !",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', phone: '04 65 84 54 88' },
  },
  {
    key: 'consigne_reminder_soon', category: 'E-commerce', label: 'Rappel retour consigne',
    defaultTemplate: "{brand} : rappel, votre ancienne pièce (commande #{orderNumber}) est à retourner avant le {dueDate}. Détails : {orderUrl} - {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['dueDate', 'Date limite retour'], ['orderUrl', 'Lien commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', dueDate: '15/07/2026', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },
  {
    key: 'consigne_overdue', category: 'E-commerce', label: 'Consigne en retard',
    defaultTemplate: "{brand} : URGENT - la date de retour consigne pour la commande #{orderNumber} est dépassée. Montant restant : {amount}€. Contactez-nous : {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['amount', 'Montant consigne dû'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', amount: '150,00', phone: '04 65 84 54 88' },
  },
  {
    key: 'consigne_received', category: 'E-commerce', label: 'Consigne reçue',
    defaultTemplate: "{brand} : nous avons bien récupéré votre ancienne pièce (commande #{orderNumber}). Consigne régularisée. Merci ! Détails : {orderUrl}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['orderUrl', 'Lien commande']],
    example: { brand: 'CarParts France', orderNumber: '10234', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc' },
  },
  {
    key: 'cloning_label_sent', category: 'E-commerce', label: 'Clonage — étiquette envoyée',
    defaultTemplate: "{brand} : votre étiquette UPS pour le clonage (commande #{orderNumber}) est disponible. Consultez votre email ou : {orderUrl} - {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['orderUrl', 'Lien commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },
  {
    key: 'cloning_piece_received', category: 'E-commerce', label: 'Clonage — pièce reçue',
    defaultTemplate: "{brand} : nous avons récupéré votre pièce pour clonage (commande #{orderNumber}). Programmation en cours, comptez 2-5 jours. Suivi : {orderUrl}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['orderUrl', 'Lien commande']],
    example: { brand: 'CarParts France', orderNumber: '10234', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc' },
  },
  {
    key: 'cloning_done', category: 'E-commerce', label: 'Clonage — terminé',
    defaultTemplate: "{brand} : clonage terminé pour la commande #{orderNumber} ! Expédition sous 24-48h. Vous recevrez le suivi par email. Détails : {orderUrl}",
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
    defaultTemplate: "{brand} : votre panier vous attend ! Finalisez votre commande ici : {recoveryUrl} - Stock limité. Question ? {phone}",
    vars: [['brand', 'Nom de la marque'], ['recoveryUrl', 'Lien de récupération du panier'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', recoveryUrl: 'https://carpartsfrance.fr/panier/recuperer/xyz', phone: '04 65 84 54 88' },
  },
  {
    key: 'status_change', category: 'E-commerce', label: 'Changement de statut',
    defaultTemplate: "{brand} : commande #{orderNumber} mise à jour : {statusLabel}. Détails : {orderUrl} - {phone}",
    vars: [['brand', 'Nom de la marque'], ['orderNumber', 'N° de commande'], ['statusLabel', 'Nouveau statut'], ['orderUrl', 'Lien commande'], ['phone', 'Téléphone marque']],
    example: { brand: 'CarParts France', orderNumber: '10234', statusLabel: 'En préparation', orderUrl: 'https://carpartsfrance.fr/compte/commandes/abc', phone: '04 65 84 54 88' },
  },

  // ─────────── MOTEUR ───────────
  {
    key: 'moteur_ack', category: 'Devis', label: 'Accusé de réception (devis)',
    defaultTemplate: "Autoliva : demande de devis {quoteRef} bien enregistrée !\nUn technicien vous recontacte sous 24h ouvrées (email ou tel).\nUrgent ? {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['phoneMoteur', 'Téléphone commercial']],
    example: { quoteRef: 'AUT-2026-06-7AB12', phoneMoteur: '04 65 84 85 39' },
  },
  {
    key: 'moteur_devis', category: 'Devis', label: 'Devis envoyé (notification + lien)',
    defaultTemplate: "Autoliva : votre devis {quoteRef} est disponible ({totalTtc}) !\nLe voir : {pdfUrl}\nValable 24h, stock limité.\nQuestions ? {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['totalTtc', 'Montant total TTC'], ['pdfUrl', 'Lien court pour voir le devis (tracké)'], ['phoneMoteur', 'Téléphone commercial']],
    example: { quoteRef: 'AUT-2026-06-7AB12', totalTtc: '1466,40 €', pdfUrl: 'https://autoliva.com/d/Xa7Qk2', phoneMoteur: '04 65 84 85 39' },
  },
  {
    key: 'moteur_relance_j7', category: 'Devis', label: 'Relance devis J+7',
    defaultTemplate: "Autoliva : votre devis {quoteRef} est toujours d'actualité.\nUne question ou réserver ? Appelez {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['phoneMoteur', 'Téléphone commercial']],
    example: { quoteRef: 'AUT-2026-06-7AB12', phoneMoteur: '04 65 84 85 39' },
  },
  {
    key: 'moteur_relance_j14', category: 'Devis', label: 'Relance devis J+14 (dernier rappel)',
    defaultTemplate: "Autoliva : dernier rappel pour votre devis {quoteRef}.\nSans nouvelle on ferme le dossier.\nToujours intéressé ? Appelez {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['phoneMoteur', 'Téléphone commercial']],
    example: { quoteRef: 'AUT-2026-06-7AB12', phoneMoteur: '04 65 84 85 39' },
  },
  {
    key: 'moteur_expedition', category: 'Devis', label: 'Expédition moteur',
    defaultTemplate: "Autoliva : votre moteur ({quoteRef}) est expédié !{trackingPart}\nQuestion ? {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['trackingPart', 'Suivi (transporteur + n° + lien)'], ['phoneMoteur', 'Téléphone commercial']],
    example: { quoteRef: 'AUT-2026-06-7AB12', trackingPart: ' Suivi DPD : XYZ789', phoneMoteur: '04 65 84 85 39' },
  },

  // ─────────── BOÎTE ───────────
  // Variante genrée du SMS d'expédition pour les leads boîte (féminin). Choisie
  // au call-site via cart.isBoite (engineQuoteAdminController.postShipment).
  {
    key: 'boite_expedition', category: 'Devis', label: 'Expédition boîte',
    defaultTemplate: "Autoliva : votre boîte ({quoteRef}) est expédiée !{trackingPart}\nQuestion ? {phoneMoteur}",
    vars: [['quoteRef', 'N° de dossier devis'], ['trackingPart', 'Suivi (transporteur + n° + lien)'], ['phoneMoteur', 'Téléphone commercial']],
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
