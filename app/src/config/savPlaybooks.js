/*
 * SAV — Playbooks par motif
 * ---------------------------------------------------------------
 * Un playbook décrit, pour un motif SAV donné :
 *   - steps     : la liste ordonnée des étapes du parcours-type
 *                 (clé, label, statut(s) associé(s), description agent,
 *                  arbre de décision pour guider l'agent)
 *   - macros    : actions 1-clic contextuelles (envoyer email, changer
 *                 statut, demander documents, etc.). Chaque macro est
 *                 déclarative → l'engine côté admin JS sait l'exécuter.
 *                 `forSteps` = étapes où la macro est pertinente.
 *   - templates : blocs de réponse pré-rédigés (variables interpolées
 *                 côté client : {nom}, {numero}, {piece}, {vehicule})
 *
 * ⚖️ Conformité droit français (réforme 2022) :
 *   - Garantie légale de conformité : Art. L217-1 à L217-20 Code conso
 *     → 2 ans (neuf) / 1 an (reconditionné). Aucun frais pour le client.
 *   - Risque transport : Art. L216-4 → vendeur responsable jusqu'à la
 *     prise de possession physique. Le client N'A PAS à prouver la faute
 *     du transporteur ni à faire de réserves.
 *   - Rétractation : Art. L221-18 à L221-28 → 14 jours calendaires.
 *     Frais retour à la charge du client UNIQUEMENT si informé avant achat.
 *   - Vices cachés : Art. 1641 Code civil → 2 ans après découverte.
 *   - Le forfait 149 € (analyse) ne peut être facturé QUE si l'analyse
 *     conclut à une cause NON couverte (usure, mauvaise installation)
 *     ET que la pièce est hors garantie légale de conformité.
 *
 * Le frontend récupère le playbook via GET /admin/api/sav/tickets/:numero/playbook
 * et affiche : stepper + macros contextuelles + bibliothèque de templates.
 */

const FSM = require('./savStateMachine');

// ------------------------------------------------------------
//  Macros réutilisables
// ------------------------------------------------------------

const MACRO = {
  askDocs: (bullets, forSteps) => ({
    id: 'ask_documents',
    label: 'Demander documents',
    icon: 'description',
    action: 'email',
    nextStatut: 'en_attente_documents',
    forSteps: forSteps || [],
    subject: 'Documents complémentaires — {numero}',
    body: [
      'Bonjour {nom},',
      '',
      'Afin de traiter votre dossier SAV <strong>{numero}</strong> dans les meilleurs délais, merci de nous transmettre les éléments suivants :',
      '<ul>' + bullets.map((b) => `<li>${b}</li>`).join('') + '</ul>',
      'Vous pouvez simplement répondre à cet email en joignant les fichiers.',
      '',
      'Merci d\'avance,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  sendReturnLabel: (forSteps) => ({
    id: 'send_return_label',
    label: 'Envoyer étiquette retour prépayée',
    icon: 'local_shipping',
    action: 'return_label',
    nextStatut: 'retour_demande',
    forSteps: forSteps || [],
    subject: 'Votre étiquette retour prépayée — {numero}',
    body: [
      'Bonjour {nom},',
      '',
      'Vous trouverez en pièce jointe votre <strong>étiquette de retour prépayée</strong>. Les frais de retour sont entièrement pris en charge.',
      'Merci de l\'imprimer, de la coller sur le colis et de le déposer dans un point relais sous 7 jours.',
      '',
      'Dès réception dans notre atelier, vous recevrez une notification et l\'analyse démarrera.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  /** Étiquette retour pour rétractation — frais à la charge du client
   *  conformément à l'Art. L221-23 (si le client a été informé avant l'achat). */
  sendReturnLabelRetractation: (forSteps) => ({
    id: 'send_return_label_retractation',
    label: 'Envoyer étiquette retour (frais client)',
    icon: 'local_shipping',
    action: 'return_label',
    nextStatut: 'retour_demande',
    forSteps: forSteps || [],
    subject: 'Retour de votre pièce — {numero}',
    body: [
      'Bonjour {nom},',
      '',
      'Suite à votre demande de rétractation pour le dossier <strong>{numero}</strong>, nous vous confirmons que votre demande est bien dans le délai légal de 14 jours.',
      '',
      'Conformément à l\'article L221-23 du Code de la consommation et comme indiqué dans nos Conditions Générales de Vente, <strong>les frais de retour sont à votre charge</strong>.',
      '',
      'Vous pouvez nous retourner la pièce par le transporteur de votre choix à l\'adresse suivante :',
      '<br><strong>CarParts France — Service Retours</strong>',
      '<br>[adresse à compléter]',
      '',
      '<strong>Important :</strong>',
      '<ul>',
      '<li>La pièce doit être dans son <strong>état d\'origine, non montée, dans son emballage</strong>.</li>',
      '<li>Merci de joindre le bon de retour (numéro de dossier : <strong>{numero}</strong>).</li>',
      '</ul>',
      '',
      'Dès réception et vérification de l\'état de la pièce, nous procéderons au remboursement sous 14 jours.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  openTransporterClaim: (forSteps) => ({
    id: 'open_transporter_claim',
    label: 'Ouvrir enquête transporteur',
    icon: 'report',
    action: 'email',
    nextStatut: 'enquete_transporteur',
    forSteps: forSteps || [],
    subject: 'Prise en charge de votre dossier — {numero}',
    body: [
      'Bonjour {nom},',
      '',
      'Nous prenons en charge votre dossier <strong>{numero}</strong> et ouvrons immédiatement une <strong>enquête auprès du transporteur</strong>.',
      '',
      'Conformément à l\'article L216-4 du Code de la consommation, en tant que vendeur, <strong>nous sommes responsables de la bonne livraison de votre commande</strong>. Vous n\'avez aucune démarche à effectuer de votre côté.',
      '<br>',
      '<strong>Ce que nous faisons :</strong>',
      '<ul>',
      '<li>Enquête auprès du transporteur (48 à 72 h ouvrées).</li>',
      '<li>Aucun frais n\'est à votre charge, quelle que soit l\'issue.</li>',
      '<li>Nous revenons vers vous avec une proposition de solution.</li>',
      '</ul>',
      '',
      '<strong>Ce que nous vous demandons :</strong> conservez le colis, l\'emballage et tous les éléments reçus le cas échéant.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  proposeRefund: (percent, forSteps) => ({
    id: `propose_refund_${percent}`,
    label: `Proposer remboursement ${percent} %`,
    icon: 'payments',
    action: 'email',
    nextStatut: 'en_attente_decision_client',
    forSteps: forSteps || [],
    subject: `Proposition de résolution — {numero}`,
    body: [
      'Bonjour {nom},',
      '',
      `Suite au traitement de votre dossier <strong>{numero}</strong>, nous vous proposons un <strong>remboursement à hauteur de ${percent} %</strong> du montant de la pièce.`,
      '',
      'Ce remboursement sera effectué sur votre moyen de paiement d\'origine sous 3 à 5 jours ouvrés après votre accord.',
      '',
      'Merci de nous confirmer votre accord en répondant simplement à cet email.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  /** Proposition de renvoi gratuit d'une pièce de remplacement */
  proposeReplacement: (forSteps) => ({
    id: 'propose_replacement',
    label: 'Proposer remplacement gratuit',
    icon: 'swap_horiz',
    action: 'email',
    nextStatut: 'en_attente_decision_client',
    forSteps: forSteps || [],
    subject: 'Remplacement de votre pièce — {numero}',
    body: [
      'Bonjour {nom},',
      '',
      'Suite à l\'étude de votre dossier <strong>{numero}</strong>, nous vous proposons le <strong>remplacement gratuit</strong> de votre pièce <strong>{piece}</strong>.',
      '',
      'Conformément à la garantie légale de conformité (Art. L217-9 du Code de la consommation), ce remplacement est <strong>sans aucun frais</strong> pour vous (pièce, transport aller et retour).',
      '',
      'Si vous préférez un remboursement plutôt qu\'un remplacement, merci de nous l\'indiquer — vous avez le choix conformément à la loi.',
      '',
      'Merci de nous confirmer votre préférence en répondant à cet email.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  refuse: (reason, forSteps) => ({
    id: `refuse_${reason.slug}`,
    label: `Refuser : ${reason.label}`,
    icon: 'block',
    action: 'email',
    nextStatut: 'refuse',
    forSteps: forSteps || [],
    subject: `Votre demande SAV {numero}`,
    body: [
      'Bonjour {nom},',
      '',
      `Après étude attentive de votre dossier <strong>{numero}</strong>, nous ne pouvons malheureusement pas donner une suite favorable : <strong>${reason.label}</strong>.`,
      '',
      reason.detail || '',
      '',
      'Nous vous rappelons que vous disposez de la possibilité de saisir gratuitement le <strong>médiateur de la consommation</strong> dont les coordonnées figurent dans nos Conditions Générales de Vente.',
      '',
      'Restant à votre disposition pour toute question.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  closeResolved: (type, forSteps) => ({
    id: `close_${type}`,
    label: type === 'garantie' ? 'Clôturer (garantie)' : 'Clôturer (facturé)',
    icon: 'task_alt',
    action: 'status_only',
    nextStatut: type === 'garantie' ? 'resolu_garantie' : 'resolu_facture',
    forSteps: forSteps || [],
  }),

  /** Colis endommagé : photos reçues mais client n'a pas fait de réserve.
   *  Art. L216-4 : le vendeur reste responsable → on ouvre l'enquête sans condition. */
  photosSansReserve: (forSteps) => ({
    id: 'photos_sans_reserve',
    label: 'Photos OK, pas de réserve — ouvrir enquête',
    icon: 'photo_camera',
    action: 'email',
    nextStatut: 'enquete_transporteur',
    forSteps: forSteps || [],
    subject: 'Prise en charge de votre dossier colis — {numero}',
    body: [
      'Bonjour {nom},',
      '',
      'Nous avons bien reçu vos photos concernant le dossier <strong>{numero}</strong>. Merci pour votre réactivité.',
      '',
      'Nous ouvrons immédiatement une <strong>enquête auprès du transporteur</strong>. Conformément à l\'article L216-4 du Code de la consommation, nous sommes responsables de la livraison en bon état de votre commande — <strong>que des réserves aient été émises ou non</strong>.',
      '',
      '<strong>Prochaines étapes :</strong>',
      '<ul>',
      '<li>Enquête transporteur en cours (48 à 72 h ouvrées).</li>',
      '<li>Aucun frais n\'est à votre charge.</li>',
      '<li>Nous revenons vers vous avec une proposition (remplacement ou remboursement).</li>',
      '</ul>',
      '',
      'Merci de conserver le colis et l\'emballage d\'origine en attendant.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),

  /** Rétractation : pièce reçue avec traces d'utilisation → remboursement partiel
   *  Art. L221-23 : le vendeur peut appliquer une dépréciation proportionnelle. */
  refundWithDepreciation: (forSteps) => ({
    id: 'refund_with_depreciation',
    label: 'Remboursement avec dépréciation (pièce utilisée)',
    icon: 'payments',
    action: 'email',
    nextStatut: 'en_attente_decision_client',
    forSteps: forSteps || [],
    subject: 'Remboursement avec ajustement — {numero}',
    body: [
      'Bonjour {nom},',
      '',
      'Nous avons bien reçu la pièce retournée dans le cadre de votre rétractation (dossier <strong>{numero}</strong>).',
      '',
      'Après examen, nous constatons que la pièce présente des <strong>traces d\'utilisation ou de montage</strong> dépassant la simple vérification de ses caractéristiques.',
      '',
      'Conformément à l\'article L221-23 du Code de la consommation, nous procédons à un <strong>remboursement avec déduction d\'une dépréciation proportionnelle</strong> à l\'utilisation constatée.',
      '',
      'Merci de nous confirmer votre accord ou de nous contacter si vous souhaitez en discuter.',
      '',
      'Cordialement,',
      'Service SAV CarParts France',
    ].join('<br>'),
  }),
};

// ------------------------------------------------------------
//  Étape utilitaire
// ------------------------------------------------------------
// `decisionTree` : tableau de { si, alors, macroId? } pour guider l'agent
// `legalNote` : rappel juridique optionnel affiché en info à l'agent
const step = (key, label, statuts, hint, decisionTree) => ({
  key, label, statuts, hint, decisionTree: decisionTree || [],
});

// ------------------------------------------------------------
//  Playbooks par motif
// ------------------------------------------------------------

const PLAYBOOKS = {

  // ─── Pièce défectueuse (flow analyse banc) ─────────────
  // ⚖️ Garantie légale de conformité : Art. L217-1 à L217-20
  //   - 2 ans (neuf) / 1 an (reconditionné) depuis livraison
  //   - Présomption d'antériorité pendant toute la durée
  //   - Aucun frais pour le consommateur (Art. L217-11)
  //   - Le client CHOISIT entre réparation et remplacement (Art. L217-9)
  //   - Le forfait 149 € ne peut s'appliquer QUE hors garantie légale
  piece_defectueuse: {
    motif: 'piece_defectueuse',
    title: 'Pièce défectueuse — Analyse banc',
    owner: 'atelier',
    steps: [
      step('qualif', 'Pré-qualification', ['ouvert', 'pre_qualification'],
        'Vérifier : date livraison (garantie légale = 2 ans neuf / 1 an reconditionné), historique commande, complétude du dossier.', [
          { si: 'Pièce livrée il y a MOINS de 2 ans (neuf) ou 1 an (reconditionné)', alors: '→ Garantie légale de conformité applicable — 0 € client, retour prépayé' },
          { si: 'Dossier incomplet (photos, VIN, symptômes manquants)', alors: '→ Demander documents', macroId: 'ask_documents' },
          { si: 'Pièce livrée il y a PLUS de 2 ans (neuf) ou 1 an (reconditionné)', alors: '→ Hors garantie légale — forfait diagnostic possible', macroId: 'refuse_hors_garantie_legale' },
          { si: 'Dossier complet et sous garantie', alors: '→ Envoyer étiquette retour prépayée', macroId: 'send_return_label' },
        ]),
      step('docs', 'Documents client', ['en_attente_documents'],
        'Facture, photos, VIN, kilométrage, symptômes précis.', [
          { si: 'Client a envoyé tous les documents', alors: '→ Envoyer étiquette retour prépayée', macroId: 'send_return_label' },
          { si: 'Documents toujours manquants après 7 j', alors: '→ Relancer (template « Relance documents J+3 »)' },
        ]),
      step('retour', 'Retour de la pièce', ['retour_demande', 'en_transit_retour'],
        '⚖️ Retour prépayé obligatoire sous garantie légale (Art. L217-11 : aucun frais pour le client).', [
          { si: 'Pièce réceptionnée à l\'atelier', alors: '→ Changer vers « Reçu atelier »' },
        ]),
      step('atelier', 'Réception atelier', ['recu_atelier'],
        'Vérifier intégrité du colis et enregistrer la pièce.', [
          { si: 'Colis intact, pièce conforme au dossier', alors: '→ Démarrer l\'analyse banc', macroId: 'start_analysis' },
          { si: 'Pièce ne correspond pas au dossier', alors: '→ Contacter le client avant analyse' },
        ]),
      step('analyse', 'Analyse banc', ['en_analyse', 'analyse_terminee', 'en_attente_fournisseur'],
        'Tests techniques + rédaction du rapport.', [
          { si: 'Analyse en cours — besoin du fournisseur', alors: '→ Contacter le fournisseur', macroId: 'contact_fournisseur' },
          { si: 'Analyse terminée', alors: '→ Marquer l\'analyse terminée', macroId: 'analysis_done' },
          { si: 'Défaut de conformité confirmé (sous garantie légale)', alors: '→ Proposer remplacement OU remboursement (choix client)', macroId: 'propose_replacement' },
          { si: 'Défaut confirmé mais hors garantie légale', alors: '→ Clôturer (garantie) — prise en charge commerciale', macroId: 'close_garantie' },
          { si: 'Aucun défaut (usure normale, mauvaise installation)', alors: '→ Restitution pièce. Si hors garantie : forfait 149 € possible', macroId: 'close_facture' },
        ]),
      step('decision', 'Décision & clôture', ['en_attente_decision_client', 'resolu_garantie', 'resolu_facture', 'clos'],
        'Communiquer la décision. ⚖️ Rappel : sous garantie légale, le client choisit entre remplacement et remboursement.', [
          { si: 'Client choisit remplacement', alors: '→ Envoyer la pièce de remplacement puis clôturer' },
          { si: 'Client choisit remboursement', alors: '→ Rembourser sous 30 j max puis clôturer' },
          { si: 'Client conteste la décision', alors: '→ Répondre via Communications — mentionner le droit à la médiation' },
        ]),
    ],
    macros: [
      MACRO.askDocs([
        'Copie de la facture d\'achat',
        'Photos de la pièce (côté montage + étiquette)',
        'Numéro VIN complet du véhicule',
        'Kilométrage au moment de la panne',
        'Description détaillée du symptôme',
      ], ['qualif', 'docs']),
      MACRO.sendReturnLabel(['qualif', 'docs', 'retour']),
      {
        id: 'start_analysis',
        label: 'Démarrer l\'analyse banc',
        icon: 'biotech',
        action: 'status_only',
        nextStatut: 'en_analyse',
        forSteps: ['atelier'],
      },
      {
        id: 'analysis_done',
        label: 'Analyse terminée — rédiger rapport',
        icon: 'fact_check',
        action: 'status_only',
        nextStatut: 'analyse_terminee',
        forSteps: ['analyse'],
      },
      {
        id: 'contact_fournisseur',
        label: 'Contacter le fournisseur',
        icon: 'contact_phone',
        action: 'status_only',
        nextStatut: 'en_attente_fournisseur',
        forSteps: ['analyse'],
      },
      MACRO.proposeReplacement(['analyse', 'decision']),
      MACRO.proposeRefund(100, ['analyse', 'decision']),
      MACRO.closeResolved('garantie', ['analyse', 'decision']),
      MACRO.closeResolved('facture', ['analyse', 'decision']),
      MACRO.refuse({ slug: 'hors_garantie_legale', label: 'Hors garantie légale de conformité',
        detail: 'Votre pièce a été livrée il y a plus de 2 ans (ou 1 an pour une pièce reconditionnée). La garantie légale de conformité (Art. L217-3 du Code de la consommation) n\'est donc plus applicable.<br><br>Nous pouvons néanmoins procéder à une analyse technique moyennant un forfait de 149 € TTC. Souhaitez-vous que nous procédions ?<br><br>Vous conservez par ailleurs la possibilité d\'invoquer la garantie des vices cachés (Art. 1641 du Code civil) pendant 2 ans à compter de la découverte du défaut.' }, ['qualif']),
    ],
    templates: [
      { key: 'accuse', label: 'Accusé de réception', body:
        'Bonjour {nom},<br><br>Nous avons bien reçu votre demande SAV <strong>{numero}</strong> concernant votre <strong>{piece}</strong>. Un technicien prend en charge votre dossier sous 48 h ouvrées.<br><br>Conformément à la garantie légale de conformité, l\'ensemble de la procédure est sans frais pour vous.<br><br>Cordialement,<br>Service SAV CarParts France' },
      { key: 'relance_docs', label: 'Relance documents J+3', body:
        'Bonjour {nom},<br><br>Nous n\'avons pas encore reçu les documents nécessaires au traitement de votre dossier <strong>{numero}</strong>. Sans retour de votre part sous 7 jours, le dossier sera clôturé automatiquement.<br><br>Cordialement,' },
    ],
  },

  // ─── Colis endommagé ────────────────────────────────────
  // ⚖️ Art. L216-4 Code conso : le vendeur supporte le risque du transport.
  //   Le client N'A PAS besoin de prouver la faute du transporteur.
  //   Le client N'A PAS besoin d'avoir fait des réserves.
  //   Le vendeur doit proposer remplacement ou remboursement sans condition.
  colis_abime: {
    motif: 'colis_abime',
    title: 'Colis endommagé — Responsabilité vendeur',
    owner: 'logistique',
    steps: [
      step('photos', 'Vérifier les photos', ['ouvert'],
        '⚖️ Art. L216-4 : le vendeur est responsable même SANS réserve du client. Les photos aident le recours transporteur mais ne conditionnent PAS la prise en charge.', [
          { si: 'Photos complètes + bordereau avec réserve', alors: '→ Ouvrir enquête transporteur (cas idéal)', macroId: 'open_transporter_claim' },
          { si: 'Photos du dommage OK mais PAS de réserve', alors: '→ Ouvrir enquête (le client n\'est pas tenu de faire des réserves)', macroId: 'photos_sans_reserve' },
          { si: 'Pas encore de photos', alors: '→ Demander photos (pour le recours transporteur, PAS comme condition)', macroId: 'ask_documents' },
          { si: 'Client signale dommage sans aucun élément', alors: '→ Demander photos — mais prise en charge obligatoire même sans', macroId: 'ask_documents' },
        ]),
      step('reserve', 'Enquête transporteur', ['reserve_transporteur', 'enquete_transporteur'],
        'Enquête interne. ⚖️ Le client n\'a aucune démarche à faire — c\'est notre recours contre le transporteur.', [
          { si: 'Enquête en cours', alors: '→ Attendre la réponse (48-72 h)' },
          { si: 'Transporteur reconnaît le dommage', alors: '→ Proposer remplacement ou remboursement au client', macroId: 'propose_replacement' },
          { si: 'Transporteur conteste — peu importe', alors: '→ On reste responsable : proposer solution au client', macroId: 'propose_refund_100' },
        ]),
      step('solution', 'Proposer une solution', ['en_attente_decision_client', 'remboursement_initie'],
        '⚖️ Le client choisit entre remplacement et remboursement (Art. L217-9 si défaut de conformité, ou Art. L216-4 pour transport).', [
          { si: 'Client préfère un remplacement', alors: '→ Proposer remplacement gratuit', macroId: 'propose_replacement' },
          { si: 'Client préfère un remboursement intégral', alors: '→ Proposer remboursement 100 %', macroId: 'propose_refund_100' },
          { si: 'Client accepte la solution', alors: '→ Clôturer (garantie)', macroId: 'close_garantie' },
        ]),
      step('cloture', 'Clôturer', ['resolu_garantie', 'resolu_facture', 'clos'],
        'Valider la résolution et envoyer l\'enquête satisfaction.', [
          { si: 'Résolution validée par le client', alors: '→ Clôturer le ticket' },
        ]),
    ],
    macros: [
      MACRO.askDocs([
        'Photos du colis extérieur (étiquette + dommages visibles)',
        'Photo du bordereau de livraison (si disponible)',
        'Photos de la pièce endommagée',
      ], ['photos']),
      MACRO.openTransporterClaim(['photos', 'reserve']),
      MACRO.photosSansReserve(['photos']),
      MACRO.proposeReplacement(['reserve', 'solution']),
      MACRO.proposeRefund(100, ['reserve', 'solution']),
      MACRO.closeResolved('garantie', ['solution', 'cloture']),
    ],
    templates: [
      { key: 'reception_photos', label: 'Accusé réception photos', body:
        'Bonjour {nom},<br><br>Nous avons bien reçu vos photos pour le dossier <strong>{numero}</strong>. Notre équipe logistique ouvre une enquête auprès du transporteur et revient vers vous sous 48 h ouvrées.<br><br>Aucune démarche n\'est nécessaire de votre côté — nous prenons tout en charge.<br><br>Cordialement,' },
    ],
  },

  // ─── Colis non reçu ─────────────────────────────────────
  // ⚖️ Art. L216-4 : risque transport = vendeur.
  //   Si le colis est perdu, le vendeur doit renvoyer ou rembourser.
  colis_non_recu: {
    motif: 'colis_non_recu',
    title: 'Colis non reçu — Enquête transporteur',
    owner: 'logistique',
    steps: [
      step('verif', 'Vérifier le suivi', ['ouvert'],
        '⚖️ Art. L216-4 : si le colis n\'est pas arrivé, c\'est notre responsabilité. Le client n\'a rien à prouver.', [
          { si: 'Tracking montre « livré » mais client dit non reçu', alors: '→ Ouvrir enquête transporteur', macroId: 'open_transporter_claim' },
          { si: 'Tracking montre « en transit » depuis > 5 jours', alors: '→ Ouvrir enquête transporteur', macroId: 'open_transporter_claim' },
          { si: 'Colis en transit < 5 jours', alors: '→ Rassurer le client, surveiller le tracking' },
        ]),
      step('enquete', 'Enquête transporteur', ['enquete_transporteur'],
        'Enquête officielle auprès du transporteur (24-72 h). Notre affaire, pas celle du client.', [
          { si: 'Transporteur confirme la perte', alors: '→ Proposer renvoi ou remboursement au client', macroId: 'propose_replacement' },
          { si: 'Transporteur a une preuve de livraison', alors: '→ Partager la preuve avec le client, proposer médiation si contesté' },
        ]),
      step('solution', 'Renvoi ou remboursement', ['remboursement_initie', 'en_attente_decision_client'],
        'Le client choisit : renvoi gratuit ou remboursement intégral.', [
          { si: 'Client accepte le renvoi ou remboursement', alors: '→ Clôturer (garantie)', macroId: 'close_garantie' },
        ]),
      step('cloture', 'Clôturer', ['resolu_garantie', 'clos'],
        'Finaliser le dossier.', []),
    ],
    macros: [
      MACRO.openTransporterClaim(['verif', 'enquete']),
      MACRO.proposeReplacement(['enquete', 'solution']),
      MACRO.proposeRefund(100, ['enquete', 'solution']),
      MACRO.closeResolved('garantie', ['solution', 'cloture']),
    ],
    templates: [
      { key: 'enquete_ouverte', label: 'Confirmation enquête', body:
        'Bonjour {nom},<br><br>L\'enquête auprès du transporteur est ouverte pour votre colis (dossier <strong>{numero}</strong>). Délai de réponse habituel : 24 à 72 h ouvrées.<br><br>Aucune démarche n\'est nécessaire de votre côté. Nous revenons vers vous avec une proposition de solution.<br><br>Cordialement,' },
    ],
  },

  // ─── Retard de livraison ────────────────────────────────
  // ⚖️ Art. L216-1 à L216-6 : si délai de livraison dépassé, le client peut
  //   demander la résolution de la vente après mise en demeure restée sans effet.
  retard_livraison: {
    motif: 'retard_livraison',
    title: 'Retard de livraison',
    owner: 'logistique',
    steps: [
      step('verif', 'Vérifier le suivi', ['ouvert'],
        'Contrôler le tracking. ⚖️ Art. L216-2 : si la date de livraison promise est dépassée, le client peut mettre en demeure et résilier.', [
          { si: 'Tracking bloqué depuis > 5 jours', alors: '→ Ouvrir enquête transporteur', macroId: 'open_transporter_claim' },
          { si: 'Retard < 3 jours, tracking en mouvement', alors: '→ Rassurer le client par email' },
          { si: 'Client demande l\'annulation (mise en demeure)', alors: '→ Rembourser intégralement sous 14 j', macroId: 'propose_refund_100' },
        ]),
      step('enquete', 'Enquête si besoin', ['enquete_transporteur'],
        'Enquête officielle si colis bloqué.', [
          { si: 'Colis retrouvé et en route', alors: '→ Informer le client et surveiller' },
          { si: 'Colis perdu', alors: '→ Proposer renvoi ou remboursement', macroId: 'propose_refund_100' },
        ]),
      step('cloture', 'Clôturer', ['resolu_garantie', 'clos'],
        'Livraison effective ou remboursement effectué.', []),
    ],
    macros: [
      MACRO.openTransporterClaim(['verif', 'enquete']),
      MACRO.proposeReplacement(['enquete']),
      MACRO.proposeRefund(100, ['verif', 'enquete']),
      MACRO.closeResolved('garantie', ['enquete', 'cloture']),
    ],
    templates: [],
  },

  // ─── Erreur de préparation ──────────────────────────────
  // ⚖️ Défaut de conformité (Art. L217-4) : la pièce livrée ne correspond pas
  //   à la commande. Remplacement ou remboursement gratuit obligatoire.
  erreur_preparation: {
    motif: 'erreur_preparation',
    title: 'Erreur de préparation',
    owner: 'logistique',
    steps: [
      step('verif', 'Vérifier l\'erreur', ['ouvert'],
        '⚖️ Art. L217-4 : pièce non conforme à la commande = défaut de conformité. Échange ou remboursement gratuit.', [
          { si: 'Erreur confirmée (photos concordantes)', alors: '→ Demander photos pour confirmation', macroId: 'ask_documents' },
          { si: 'Client a reçu la bonne pièce (erreur client)', alors: '→ Expliquer au client — possibilité de rétractation 14 j si non montée' },
        ]),
      step('retour', 'Retour de la pièce erronée', ['retour_demande', 'en_transit_retour', 'recu_atelier'],
        '⚖️ Retour prépayé obligatoire (notre erreur → Art. L217-11 : aucun frais client).', [
          { si: 'Erreur confirmée par photos', alors: '→ Envoyer étiquette retour prépayée', macroId: 'send_return_label' },
          { si: 'Pièce reçue à l\'atelier', alors: '→ Préparer le renvoi de la bonne pièce' },
        ]),
      step('renvoi', 'Renvoi de la bonne pièce', ['en_attente_decision_client', 'resolu_garantie'],
        'Expédier la bonne pièce — sans frais.', [
          { si: 'Client préfère remboursement plutôt qu\'échange', alors: '→ Rembourser 100 %', macroId: 'propose_refund_100' },
          { si: 'Bonne pièce expédiée', alors: '→ Clôturer (garantie)', macroId: 'close_garantie' },
        ]),
      step('cloture', 'Clôturer', ['resolu_garantie', 'clos'],
        'Valider la livraison de la bonne pièce.', []),
    ],
    macros: [
      MACRO.askDocs([
        'Photo de l\'étiquette de la pièce reçue',
        'Photo de la pièce reçue',
      ], ['verif']),
      MACRO.sendReturnLabel(['verif', 'retour']),
      MACRO.proposeReplacement(['retour', 'renvoi']),
      MACRO.proposeRefund(100, ['renvoi']),
      MACRO.closeResolved('garantie', ['renvoi', 'cloture']),
    ],
    templates: [
      { key: 'excuse', label: 'Excuse + action', body:
        'Bonjour {nom},<br><br>Nous sommes sincèrement désolés pour l\'erreur sur votre commande <strong>{numero}</strong>. Nous prenons immédiatement en charge l\'envoi de la bonne pièce, sans aucun frais pour vous.<br><br>Vous recevrez une étiquette de retour prépayée pour nous renvoyer la pièce erronée.<br><br>Cordialement,' },
    ],
  },

  // ─── Rétractation 14j ───────────────────────────────────
  // ⚖️ Art. L221-18 à L221-28 Code conso :
  //   - 14 jours calendaires à compter de la réception
  //   - Pas besoin de motiver
  //   - Frais retour : à la charge du client SI informé avant l'achat (L221-23)
  //   - Remboursement : sous 14 j après notification de la rétractation
  //     (différable jusqu'à réception du retour ou preuve d'envoi)
  //   - Pièce montée/utilisée : le vendeur peut déduire une dépréciation (L221-23)
  //     mais NE PEUT PAS refuser systématiquement le retour
  //   - Exception L221-28 6° : bien mélangé de façon indissociable (très rare pour auto)
  retractation: {
    motif: 'retractation',
    title: 'Rétractation 14 jours',
    owner: 'commercial',
    steps: [
      step('verif', 'Vérifier éligibilité', ['ouvert', 'retractation_recue'],
        '⚖️ Calculer : date livraison + 14 j calendaires. Le client n\'a PAS à justifier sa rétractation.', [
          { si: 'Dans le délai 14 j + pièce non montée', alors: '→ Accepter, envoyer les infos retour (frais client si prévu aux CGV)', macroId: 'send_return_label_retractation' },
          { si: 'Dans le délai 14 j + pièce montée', alors: '→ Accepter MAIS prévoir dépréciation (Art. L221-23) — PAS un refus total' },
          { si: 'Hors délai (> 14 j après livraison)', alors: '→ Refuser : Hors délai', macroId: 'refuse_hors_delai' },
          { si: 'Pièce indissociable du véhicule (soudée, collée…)', alors: '→ Exception L221-28 6° possible — vérifier au cas par cas' },
        ]),
      step('retour', 'Retour de la pièce', ['retour_demande', 'en_transit_retour', 'recu_atelier'],
        '⚖️ Frais de retour à la charge du client si mentionné dans les CGV avant l\'achat (Art. L221-23).', [
          { si: 'Pièce reçue en état neuf / non utilisée', alors: '→ Remboursement intégral (prix pièce + livraison initiale standard)', macroId: 'propose_refund_100' },
          { si: 'Pièce avec traces de montage/utilisation', alors: '→ Remboursement avec dépréciation proportionnelle', macroId: 'refund_with_depreciation' },
        ]),
      step('remb', 'Remboursement', ['remboursement_initie'],
        '⚖️ Remboursement obligatoire sous 14 j max après réception du retour (Art. L221-24). Inclut les frais de livraison initiale (standard).', [
          { si: 'Remboursement effectué', alors: '→ Clôturer (garantie)', macroId: 'close_garantie' },
        ]),
      step('cloture', 'Clôturer', ['resolu_garantie', 'clos'], '', []),
    ],
    macros: [
      MACRO.sendReturnLabelRetractation(['verif', 'retour']),
      MACRO.proposeRefund(100, ['retour', 'remb']),
      MACRO.refundWithDepreciation(['retour']),
      MACRO.closeResolved('garantie', ['remb', 'cloture']),
      MACRO.refuse({ slug: 'hors_delai', label: 'Hors délai de rétractation (14 jours)',
        detail: 'Votre demande de rétractation a été reçue plus de 14 jours calendaires après la livraison de votre commande (Art. L221-18 du Code de la consommation).<br><br>Vous conservez néanmoins le bénéfice de la garantie légale de conformité (2 ans) en cas de défaut de la pièce, ainsi que de la garantie des vices cachés (Art. 1641 du Code civil).' }, ['verif']),
    ],
    templates: [],
  },

  // ─── Pièce non compatible ───────────────────────────────
  // ⚖️ Si l'incompatibilité est due à une erreur du vendeur (mauvaise fiche produit,
  //   mauvaise recommandation) → défaut de conformité (Art. L217-4 et L217-5).
  //   Si l'erreur vient du client → droit de rétractation 14 j applicable.
  non_compatible: {
    motif: 'non_compatible',
    title: 'Pièce non compatible',
    owner: 'commercial',
    steps: [
      step('verif', 'Vérifier la compatibilité', ['ouvert'],
        '⚖️ Qui a fait l\'erreur ? Si notre fiche produit était incorrecte → défaut de conformité (retour gratuit). Si le client s\'est trompé → rétractation 14 j possible.', [
          { si: 'Incompatibilité = erreur fiche produit / conseil vendeur', alors: '→ Défaut de conformité : retour gratuit + échange/remboursement', macroId: 'ask_documents' },
          { si: 'Client a choisi la mauvaise référence tout seul', alors: '→ Proposer rétractation 14 j si dans le délai — frais retour client' },
          { si: 'Doute sur la cause', alors: '→ Demander VIN + photos pour trancher', macroId: 'ask_documents' },
        ]),
      step('retour', 'Retour de la pièce', ['retour_demande', 'en_transit_retour', 'recu_atelier'],
        'Si défaut de conformité : retour prépayé. Si rétractation : frais client.', [
          { si: 'Incompatibilité confirmée par VIN vs référence', alors: '→ Envoyer étiquette retour prépayée', macroId: 'send_return_label' },
          { si: 'Pièce reçue en retour', alors: '→ Proposer échange ou remboursement', macroId: 'propose_refund_100' },
        ]),
      step('cloture', 'Échange ou remboursement', ['resolu_garantie', 'clos'],
        'Le client choisit : bonne référence ou remboursement.', []),
    ],
    macros: [
      MACRO.askDocs([
        'Numéro VIN complet (17 caractères)',
        'Photo de la pièce d\'origine à remplacer',
        'Référence constructeur gravée sur la pièce',
        'Capture d\'écran de la page produit au moment de l\'achat (si possible)',
      ], ['verif']),
      MACRO.sendReturnLabel(['verif', 'retour']),
      MACRO.proposeReplacement(['retour', 'cloture']),
      MACRO.proposeRefund(100, ['retour']),
      MACRO.closeResolved('garantie', ['cloture']),
    ],
    templates: [],
  },

  // ─── Facture / document ─────────────────────────────────
  facture_document: {
    motif: 'facture_document',
    title: 'Demande facture / document',
    owner: 'compta',
    steps: [
      step('verif', 'Localiser le document', ['ouvert'],
        'Rechercher la facture dans Qonto/Prestashop.', [
          { si: 'Document trouvé', alors: '→ Envoyer le document au client', macroId: 'send_document' },
          { si: 'Document introuvable', alors: '→ Contacter la compta puis revenir vers le client' },
        ]),
      step('envoi', 'Envoyer par email', ['en_attente_decision_client', 'resolu_garantie'],
        'Transmettre le document au client.', [
          { si: 'Client confirme réception', alors: '→ Clôturer (garantie)', macroId: 'close_garantie' },
        ]),
      step('cloture', 'Clôturer', ['resolu_garantie', 'clos'], '', []),
    ],
    macros: [
      {
        id: 'send_document',
        label: 'Envoyer le document au client',
        icon: 'attach_email',
        action: 'email',
        nextStatut: 'en_attente_decision_client',
        forSteps: ['verif', 'envoi'],
        subject: 'Votre document — {numero}',
        body: [
          'Bonjour {nom},',
          '',
          'Vous trouverez en pièce jointe le document demandé pour le dossier <strong>{numero}</strong>.',
          '',
          'Si vous avez besoin d\'un autre document, n\'hésitez pas à nous le faire savoir.',
          '',
          'Cordialement,',
          'Service SAV CarParts France',
        ].join('<br>'),
      },
      MACRO.closeResolved('garantie', ['envoi', 'cloture']),
    ],
    templates: [
      { key: 'envoi_facture', label: 'Envoi facture', body:
        'Bonjour {nom},<br><br>Vous trouverez en pièce jointe votre facture pour la commande <strong>{numero}</strong>.<br><br>Cordialement,' },
    ],
  },

  // ─── Remboursement ──────────────────────────────────────
  remboursement: {
    motif: 'remboursement',
    title: 'Demande de remboursement',
    owner: 'compta',
    steps: [
      step('verif', 'Vérifier le fondement', ['ouvert'],
        '⚖️ Identifier le fondement juridique : garantie légale, rétractation, erreur vendeur, geste commercial ?', [
          { si: 'Sous garantie légale de conformité (< 2 ans)', alors: '→ Remboursement obligatoire sans frais (Art. L217-12)', macroId: 'propose_refund_100' },
          { si: 'Rétractation dans les 14 j', alors: '→ Appliquer le process rétractation' },
          { si: 'Hors garantie — geste commercial', alors: '→ Proposer remboursement 50 % (décision managériale)', macroId: 'propose_refund_50' },
          { si: 'Non justifié et hors délai', alors: '→ Expliquer les droits au client, mentionner la médiation' },
        ]),
      step('remb', 'Initier remboursement', ['remboursement_initie'],
        '⚖️ Délai max : 14 j (rétractation), 30 j (garantie conformité après choix remboursement).', [
          { si: 'Remboursement effectué', alors: '→ Clôturer (garantie)', macroId: 'close_garantie' },
        ]),
      step('cloture', 'Clôturer', ['resolu_garantie', 'clos'], '', []),
    ],
    macros: [
      MACRO.proposeRefund(100, ['verif', 'remb']),
      MACRO.proposeRefund(50, ['verif']),
      MACRO.closeResolved('garantie', ['remb', 'cloture']),
    ],
    templates: [],
  },

  // ─── Autre demande ──────────────────────────────────────
  autre: {
    motif: 'autre',
    title: 'Autre demande',
    owner: 'sav_general',
    steps: [
      step('lecture', 'Lire le message', ['ouvert'], 'Comprendre la demande et décider de l\'action.', [
        { si: 'Demande claire et actionnable', alors: '→ Traiter puis clôturer' },
        { si: 'Demande floue', alors: '→ Demander des précisions au client' },
      ]),
      step('traitement', 'Traiter', ['en_attente_decision_client', 'en_attente_documents'], '', []),
      step('cloture', 'Clôturer', ['resolu_garantie', 'clos'], '', []),
    ],
    macros: [
      MACRO.askDocs([
        'Précisions sur votre demande',
        'Tout document utile au traitement',
      ], ['lecture', 'traitement']),
      MACRO.closeResolved('garantie', ['traitement', 'cloture']),
    ],
    templates: [],
  },
};

// ------------------------------------------------------------
//  API publique
// ------------------------------------------------------------

function getPlaybook(motif) {
  return PLAYBOOKS[motif] || PLAYBOOKS.autre;
}

/**
 * Calcule l'étape courante du playbook selon le statut actuel.
 * Retourne l'index (0-based) de la première étape dont le statut contient
 * le statut courant. -1 si non trouvé.
 */
function currentStepIndex(motif, statut) {
  const pb = getPlaybook(motif);
  for (let i = 0; i < pb.steps.length; i++) {
    if (pb.steps[i].statuts.indexOf(statut) !== -1) return i;
  }
  return -1;
}

/**
 * Retourne les macros exécutables dans le statut courant,
 * filtrées par étape du playbook (forSteps) ET par FSM.
 *
 * ▸ Si la macro a un forSteps non-vide, elle ne s'affiche que si
 *   l'étape courante est dans cette liste.
 * ▸ Si forSteps est vide/absent, elle s'affiche si la transition FSM le permet.
 * ▸ La 1ère macro dont le decisionTree la recommande reçoit `recommended: true`.
 */
function availableMacros(motif, statut) {
  const pb = getPlaybook(motif);
  const stepIdx = currentStepIndex(motif, statut);
  const currentStep = stepIdx >= 0 ? pb.steps[stepIdx] : null;
  const currentStepKey = currentStep ? currentStep.key : null;

  const macros = (pb.macros || []).filter((m) => {
    // 1. FSM gate : la transition doit être possible
    if (m.nextStatut && m.nextStatut !== statut && !FSM.canTransition(statut, m.nextStatut)) {
      return false;
    }
    // 2. Step gate : si forSteps défini, la macro doit correspondre à l'étape courante
    if (m.forSteps && m.forSteps.length > 0 && currentStepKey) {
      return m.forSteps.indexOf(currentStepKey) !== -1;
    }
    // forSteps vide = visible à toutes les étapes (rétro-compatible)
    return true;
  });

  // Marquer la macro recommandée : chercher dans le decisionTree de l'étape courante
  if (currentStep && currentStep.decisionTree && currentStep.decisionTree.length > 0) {
    const recommended = currentStep.decisionTree.find((d) => d.macroId);
    if (recommended) {
      const rec = macros.find((m) => m.id === recommended.macroId);
      if (rec) rec.recommended = true;
    }
  }

  return macros;
}

/**
 * Sérialise le playbook pour le frontend avec des métadonnées utiles :
 * - index étape courante
 * - macros exécutables maintenant (filtrées par étape + FSM)
 * - arbre de décision de l'étape courante
 * - transitions autorisées depuis le statut courant
 */
function playbookForTicket(ticket) {
  const motif = (ticket && ticket.motifSav) || 'autre';
  const statut = (ticket && ticket.statut) || 'ouvert';
  const pb = getPlaybook(motif);
  const idx = currentStepIndex(motif, statut);
  const currentStep = idx >= 0 ? pb.steps[idx] : null;
  return {
    motif,
    title: pb.title,
    owner: pb.owner,
    currentStepIndex: idx,
    steps: pb.steps.map((s, i) => ({
      key: s.key,
      label: s.label,
      hint: s.hint,
      statuts: s.statuts,
      decisionTree: s.decisionTree || [],
      done: idx > i,
      current: idx === i,
    })),
    macros: availableMacros(motif, statut),
    decisionTree: currentStep ? (currentStep.decisionTree || []) : [],
    templates: pb.templates || [],
    allowedNextStatuts: FSM.allowedNext(statut).map((s) => ({ key: s, label: FSM.labelOf(s) })),
    statutLabel: FSM.labelOf(statut),
  };
}

module.exports = {
  PLAYBOOKS,
  getPlaybook,
  currentStepIndex,
  availableMacros,
  playbookForTicket,
};
