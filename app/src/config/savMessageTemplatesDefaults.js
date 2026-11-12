/*
 * Modèles de message SAV livrés avec le site.
 *
 * Ils sont copiés UNE FOIS dans la collection des modèles d'équipe
 * (SavMessageTemplate, repère `builtinKey`) : ensuite l'équipe les modifie ou les
 * supprime comme les autres, et un modèle supprimé ne revient pas.
 *
 * Trois origines, jusqu'ici figées dans le code :
 *   - composeur   : puces écrites en dur dans la fiche ticket ;
 *   - bibliotheque: ancienne route /message-templates ;
 *   - playbook    : modèles propres à un motif (savPlaybooks), affichés
 *                   seulement sur les tickets de ce motif.
 */

const brand = require('./brand');
const { PLAYBOOKS } = require('./savPlaybooks');

// Les modèles des playbooks sont en HTML ; le composeur travaille en texte.
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function defaultMessageTemplates() {
  const list = [
    { builtinKey: 'composeur:reception', title: 'Pièce reçue', body: 'Bonjour {client_prenom},\n\nNous avons bien reçu votre pièce ({piece_type}) à notre atelier. L\'analyse sur banc démarrera dans les jours qui viennent.\n\nDossier : {ticket_numero}' },
    { builtinKey: 'composeur:analyse_ok', title: 'Défaut confirmé', body: 'Bonjour {client_prenom},\n\nBonne nouvelle : notre analyse confirme un défaut produit sur votre {piece_type}. Nous allons procéder à l\'échange/remboursement.\n\nDossier : {ticket_numero}' },
    { builtinKey: 'composeur:analyse_neg', title: 'Pas de défaut', body: 'Bonjour {client_prenom},\n\nNotre rapport d\'analyse est terminé. La pièce {piece_type} ne présente pas de défaut produit : un forfait de 149 € TTC vous sera facturé conformément aux CGV SAV.\n\nDossier : {ticket_numero}' },
    { builtinKey: 'composeur:relance_doc', title: 'Relance docs', body: 'Bonjour {client_prenom},\n\nPour traiter votre dossier {ticket_numero}, nous avons besoin de la facture du garage {garage_nom} et de la confirmation du réglage de base.' },
    { builtinKey: 'composeur:rdv', title: 'RDV', body: 'Bonjour {client_prenom},\n\nPouvez-vous nous confirmer le rendez-vous {rendez_vous_date} pour la prise en charge de votre dossier {ticket_numero} ?' },
    { builtinKey: 'bibliotheque:piece_recue', title: 'Pièce reçue atelier', body: `Bonjour {client_prenom},\n\nNous avons bien reçu votre pièce à l'atelier. Notre équipe technique va procéder au diagnostic sur banc dans les prochains jours ouvrés.\n\nNous reviendrons vers vous dès que l'analyse sera terminée.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { builtinKey: 'bibliotheque:diag_positif', title: 'Diagnostic positif (garantie)', body: `Bonjour {client_prenom},\n\nL'analyse de votre {piece_type} est terminée. Nous avons effectivement constaté un défaut produit pris en charge au titre de notre garantie.\n\nNous procédons à un échange standard, expédition sous 48h ouvrées.\n\nVous recevrez un numéro de suivi dès expédition.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { builtinKey: 'bibliotheque:diag_negatif', title: 'Diagnostic négatif (non défectueux)', body: `Bonjour {client_prenom},\n\nL'analyse de votre {piece_type} est terminée. Après tests complets sur banc dédié, votre pièce est conforme aux valeurs constructeur et ne présente pas de défaut.\n\nConformément à nos CGV SAV, le forfait d'analyse de 149 € TTC est dû. Un lien de paiement sécurisé vous sera envoyé séparément.\n\nVous trouverez en pièce jointe le rapport d'analyse complet.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { builtinKey: 'bibliotheque:mauvais_montage', title: 'Mauvais montage détecté', body: `Bonjour {client_prenom},\n\nL'analyse de votre {piece_type} est terminée. Les tests ont révélé des traces de mauvais montage (absence de réglage base, serrages non conformes) qui excluent la prise en charge sous garantie.\n\nConformément à nos CGV SAV, le forfait d'analyse de 149 € TTC est dû. Un lien de paiement sécurisé vous sera envoyé séparément.\n\nLe rapport détaillé est joint à ce message.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { builtinKey: 'bibliotheque:relance_docs', title: 'Relance documents manquants', body: `Bonjour {client_prenom},\n\nAfin de pouvoir traiter votre dossier SAV n° {numero}, nous vous invitons à nous transmettre les documents suivants :\n\n• Facture de montage du garage\n• Photos du compteur kilométrique\n• Confirmation du réglage de base effectué\n\nSans ces éléments, nous ne pourrons pas poursuivre la prise en charge.\n\nMerci pour votre retour rapide,\nL'équipe SAV ${brand.NAME}` },
    { builtinKey: 'bibliotheque:etiquette_retour', title: 'Étiquette de retour envoyée', body: `Bonjour {client_prenom},\n\nVous trouverez ci-joint l'étiquette prépayée pour nous retourner votre {piece_type}.\n\nMerci de :\n• Emballer soigneusement la pièce (carton + calage)\n• Coller l'étiquette bien visible\n• Déposer le colis en point relais ou bureau de poste\n\nDès réception à l'atelier, nous démarrerons l'analyse.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
  ];
  Object.keys(PLAYBOOKS).forEach((motif) => {
    (PLAYBOOKS[motif].templates || []).forEach((t) => {
      list.push({ builtinKey: `playbook:${motif}:${t.key}`, title: t.label, body: htmlToText(t.body), motifs: [motif] });
    });
  });
  return list.map((t) => Object.assign({ motifs: [] }, t));
}

module.exports = { defaultMessageTemplates, htmlToText };
