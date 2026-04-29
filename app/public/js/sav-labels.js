/* SAV labels — dictionnaires FR pour statuts & types de pièces
 * Exposé sur window.SAV_LABELS pour consommation par sav-admin.js
 */
(function () {
  'use strict';

  var STATUT_LABELS = {
    ouvert: 'Ouvert',
    pre_qualification: 'Pré-qualification',
    en_attente_documents: 'En attente de documents',
    relance_1: 'Relance 1',
    relance_2: 'Relance 2',
    clos_sans_reponse: 'Clos (sans réponse)',
    retour_demande: 'Retour demandé',
    en_transit_retour: 'En transit retour',
    recu_atelier: 'Reçu atelier',
    en_analyse: 'En analyse',
    analyse_terminee: 'Analyse terminée',
    en_attente_decision_client: 'Attente décision client',
    en_attente_fournisseur: 'Attente fournisseur',
    resolu_garantie: 'Résolu (garantie)',
    resolu_facture: 'Résolu (facturé)',
    clos: 'Clôturé',
    refuse: 'Refusé',
  };

  // Classes Tailwind → fond + texte pour chaque statut
  var STATUT_CLASSES = {
    ouvert: 'bg-sky-100 text-sky-800',
    pre_qualification: 'bg-sky-100 text-sky-800',
    en_attente_documents: 'bg-amber-100 text-amber-800',
    relance_1: 'bg-amber-100 text-amber-800',
    relance_2: 'bg-orange-100 text-orange-800',
    clos_sans_reponse: 'bg-slate-200 text-slate-600',
    retour_demande: 'bg-cyan-100 text-cyan-800',
    en_transit_retour: 'bg-cyan-100 text-cyan-800',
    recu_atelier: 'bg-blue-100 text-blue-800',
    en_analyse: 'bg-violet-200 text-violet-900',
    analyse_terminee: 'bg-amber-100 text-amber-800',
    en_attente_decision_client: 'bg-orange-100 text-orange-800',
    en_attente_fournisseur: 'bg-purple-100 text-purple-800',
    resolu_garantie: 'bg-emerald-100 text-emerald-800',
    resolu_facture: 'bg-emerald-100 text-emerald-800',
    clos: 'bg-slate-200 text-slate-700',
    refuse: 'bg-red-100 text-red-800',
  };

  var PIECE_LABELS = {
    mecatronique: 'Mécatronique DSG',
    boite_vitesses: 'Boîte de vitesses',
    moteur: 'Moteur',
    arbre_transmission: 'Arbre de transmission',
    visco_coupleur: 'Visco-coupleur',
    turbo: 'Turbo',
    injecteur: 'Injecteur',
    boite_transfert: 'Boîte de transfert',
    pont: 'Pont',
    differentiel: 'Différentiel',
    haldex: 'Haldex',
    reducteur: 'Réducteur',
    cardan: 'Cardan',
    autre: 'Autre',
    // Legacy
    mecatronique_dq200: 'Mécatronique DQ200',
    mecatronique_dq250: 'Mécatronique DQ250',
    mecatronique_dq381: 'Mécatronique DQ381',
    mecatronique_dq500: 'Mécatronique DQ500',
  };

  // Ordre affiché dans le Kanban
  var KANBAN_COLUMNS = [
    { key: 'nouveau', label: 'Nouveau', statuts: ['ouvert', 'pre_qualification'] },
    { key: 'docs', label: 'Attente docs', statuts: ['en_attente_documents', 'relance_1', 'relance_2'] },
    { key: 'retour', label: 'Retour / Transit', statuts: ['retour_demande', 'en_transit_retour'] },
    { key: 'atelier', label: 'Reçu atelier', statuts: ['recu_atelier'] },
    { key: 'analyse', label: 'En analyse', statuts: ['en_analyse', 'analyse_terminee'] },
    { key: 'decision', label: 'Décision client', statuts: ['en_attente_decision_client', 'en_attente_fournisseur'] },
    { key: 'resolus', label: 'Résolus', statuts: ['resolu_garantie', 'resolu_facture'] },
    { key: 'clos', label: 'Clos / Refusés', statuts: ['clos', 'clos_sans_reponse', 'refuse'] },
  ];

  function statutLabel(s) { return STATUT_LABELS[s] || s || '—'; }
  function statutClass(s) { return STATUT_CLASSES[s] || 'bg-slate-100 text-slate-700'; }
  function pieceLabel(t) { return PIECE_LABELS[t] || t || '—'; }

  window.SAV_LABELS = {
    STATUT_LABELS: STATUT_LABELS,
    STATUT_CLASSES: STATUT_CLASSES,
    PIECE_LABELS: PIECE_LABELS,
    KANBAN_COLUMNS: KANBAN_COLUMNS,
    statutLabel: statutLabel,
    statutClass: statutClass,
    pieceLabel: pieceLabel,
  };
})();
