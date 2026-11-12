'use strict';

/**
 * Chiffres SAV de la page publique /sav/notre-engagement, calculés au rendu.
 *
 * ── Pourquoi (audit du 25/09/2026) ───────────────────────────────────────────
 *
 * La page montrait « — % de défauts produits confirmés » et « — dossiers en
 * cours » : des cases vides qu'un appel JavaScript remplissait ou non (jamais
 * pour un robot qui lit le HTML), plus un « 5j » écrit en dur présenté comme un
 * délai moyen mesuré « en temps réel ». Seul un chiffre MESURÉ est affiché :
 *   - le taux de défauts produit, seulement si au moins une analyse est
 *     conclue — aucune analyse ne fait pas « 0 % » ;
 *   - les dossiers en cours, seulement s'il y en a.
 * Rien à montrer, pas de base, ou une erreur : null, et la section disparaît.
 */

const mongoose = require('mongoose');

/* Mêmes statuts « en cours » que GET /api/sav/stats-publiques. */
const STATUTS_EN_COURS = [
  'ouvert', 'pre_qualification', 'en_attente_documents', 'retour_demande', 'en_transit_retour',
  'recu_atelier', 'en_analyse', 'analyse_terminee', 'en_attente_decision_client',
];

/** Pur : ce que la page peut afficher à partir des trois comptes. */
function chiffresAffichables({ enCours = 0, analyses = 0, defauts = 0 } = {}) {
  const taux = analyses > 0 ? Math.round((defauts / analyses) * 100) : null;
  const ouverts = enCours > 0 ? enCours : null;
  if (taux === null && ouverts === null) return null;
  return { tauxDefautProduit: taux, dossiersEnCours: ouverts };
}

async function chiffresSavPublics() {
  /* Sans base, une requête Mongoose attendrait la reconnexion (10 s) : la
     page se sert tout de suite, sans chiffres. */
  if (mongoose.connection.readyState !== 1) return null;
  try {
    const SavTicket = require('../models/SavTicket');
    const [enCours, analyses, defauts] = await Promise.all([
      SavTicket.countDocuments({ statut: { $in: STATUTS_EN_COURS } }),
      SavTicket.countDocuments({ 'analyse.conclusion': { $exists: true, $nin: [null, ''] } }),
      SavTicket.countDocuments({ 'analyse.conclusion': 'defaut_produit' }),
    ]);
    return chiffresAffichables({ enCours, analyses, defauts });
  } catch (err) {
    console.error('[sav] chiffres publics indisponibles :', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = { chiffresSavPublics, chiffresAffichables, STATUTS_EN_COURS };
