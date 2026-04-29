/*
 * faqContent.js
 *
 * Source unique pour les Q/R de la page /faq.
 * Utilisé par :
 *   - routes/index.js → rendu HTML (boucle <details>) + JSON-LD FAQPage
 *
 * IMPORTANT : si tu modifies cette liste, l'HTML + le JSON-LD restent
 * synchronisés automatiquement (template itère sur ce tableau).
 *
 * Format : `answer` peut contenir du HTML (liens vers /contact, etc.).
 * Les placeholders `%phone%` et `%phoneIntl%` sont remplacés au render
 * avec les valeurs courantes du brand config.
 */

'use strict';

const FAQ_ITEMS = [
  {
    question: "Quels sont les délais de livraison ?",
    answer: "Les expéditions sont effectuées sous 24 à 48 h ouvrées après validation de votre commande. La livraison prend ensuite 2 à 5 jours ouvrés selon votre localisation. Vous recevrez un e-mail avec le numéro de suivi dès l'envoi de votre colis.",
  },
  {
    question: "Comment fonctionne l'échange standard ?",
    answer: "Vous recevez d'abord votre pièce reconditionnée. Vous disposez ensuite de 30 jours pour nous retourner l'ancienne pièce. Si vous ne renvoyez pas l'ancienne pièce dans le délai imparti, la consigne vous sera facturée.",
  },
  {
    question: "Comment vérifier la compatibilité avec mon véhicule ?",
    answer: "Chaque fiche produit indique les véhicules compatibles. En cas de doute, envoyez-nous votre numéro VIN (visible sur votre carte grise, case E) via le formulaire de <a href=\"/contact\" class=\"text-primary font-bold hover:underline\">contact</a> ou par téléphone au %phone%. Nous vérifierons la compatibilité gratuitement avant expédition.",
    answerPlain: "Chaque fiche produit indique les véhicules compatibles. En cas de doute, envoyez-nous votre numéro VIN (visible sur votre carte grise, case E) via le formulaire de contact ou par téléphone au %phone%. Nous vérifierons la compatibilité gratuitement avant expédition.",
  },
  {
    question: "Quels moyens de paiement acceptez-vous ?",
    answer: "Nous acceptons les cartes bancaires (Visa, Mastercard) via Mollie, ainsi que le paiement en 3 ou 4 fois sans frais via Scalapay. Tous les paiements sont sécurisés et chiffrés.",
  },
  {
    question: "Quelle est la durée de la garantie ?",
    answer: "Toutes nos pièces reconditionnées sont garanties jusqu'à 24 mois. La durée exacte est indiquée sur chaque fiche produit. La garantie couvre les défauts de reconditionnement, hors usure normale et erreur de montage.",
  },
  {
    question: "Comment effectuer un retour ou une réclamation ?",
    answer: "Contactez notre support via le formulaire de <a href=\"/contact\" class=\"text-primary font-bold hover:underline\">contact</a> ou par téléphone. Nous vous fournirons une étiquette de retour et les instructions. Les retours sont acceptés sous 14 jours après réception, à condition que la pièce n'ait pas été montée.",
    answerPlain: "Contactez notre support via le formulaire de contact ou par téléphone. Nous vous fournirons une étiquette de retour et les instructions. Les retours sont acceptés sous 14 jours après réception, à condition que la pièce n'ait pas été montée.",
  },
  {
    question: "Livrez-vous en dehors de la France ?",
    answer: "Oui, nous livrons dans toute l'Europe. Les frais et délais varient selon la destination. Contactez-nous pour obtenir un devis de livraison personnalisé vers votre pays.",
  },
];

/**
 * Interpole les placeholders et retourne les items "render-ready".
 * @param {Object} params - { phone, phoneIntl }
 * @returns {Array<{question:string, answer:string, answerPlain:string}>}
 */
function getFaqItems({ phone = '', phoneIntl = '' } = {}) {
  return FAQ_ITEMS.map((item) => {
    const replace = (s) => String(s || '')
      .replace(/%phone%/g, phone)
      .replace(/%phoneIntl%/g, phoneIntl);
    return {
      question: item.question,
      answer: replace(item.answer),
      answerPlain: replace(item.answerPlain || item.answer.replace(/<[^>]+>/g, '')),
    };
  });
}

module.exports = { FAQ_ITEMS, getFaqItems };
