'use strict';

/**
 * Charge la file de travail « À traiter » de /admin/activite-panier.
 *
 * Les échéances sont CALCULÉES (services/leadWork.js) pour chaque dossier
 * ouvert, puis triées, AVANT tout découpage en pages : un tri fait après la
 * pagination cachait les vieux dossiers (c'est ce qui laissait 197 demandes
 * « Nouveau » invisibles). Les volumes actuels (quelques centaines de dossiers
 * ouverts) se calculent en mémoire en quelques millisecondes ; un plafond de
 * sécurité est journalisé s'il est atteint.
 */

const AbandonedCart = require('../models/AbandonedCart');
const ho = require('./heuresOuvrees');
const { computeWork, comparer, GROUPES, SOURCES_DEMANDE } = require('./leadWork');

/** Fenêtre des dossiers repris dans la file (au-delà : onglet « Tous »). */
const FENETRE_JOURS = 120;
const PLAFOND = 4000;
/** Cartes affichées par groupe avant « Afficher les suivants ». */
const PAR_GROUPE = 15;

const CHAMPS = [
  '_id', 'sessionId', 'email', 'phone', 'firstName', 'lastName', 'captureSource', 'status', 'manualStatus',
  'manualStatusAt', 'manualStatusByName', 'lastManualContactAt', 'manualEmailsSent', 'manualSmsSent',
  'requested', 'attribution', 'items.name', 'items.image', 'totalAmountCents', 'contextMessage',
  'engineQuote.status', 'engineQuote.sentQuotes.sentAt', 'engineQuote.sentQuotes.openedAt',
  'engineQuote.sentQuotes.pdfViewedAt', 'engineQuote.sentQuotes.payClickedAt', 'engineQuote.autoDevis.status',
  'engineQuote.identifiedEngine.model', 'engineQuote.identifiedEngine.code', 'engineQuote.pricing.sellPrice',
  'recoveredOrder', 'archived', 'nextAction', 'takenByName', 'takenAt', 'lastCallOutcome', 'lostReason',
  'communications.canal', 'communications.sens', 'communications.auto', 'communications.statut',
  'communications.at', 'communications.par', 'abandonedAt', 'createdAt', 'lastActivityAt', 'lastRemindedAt',
  'recoveredAt', 'repurchaseReminder',
].join(' ');

/** Catégorie de pièce pour le filtre rapide. */
function categorie(lead) {
  const src = lead.captureSource || '';
  if (src === 'landing_ponts') return 'pont';
  if (src === 'landing_boites') return 'boite';
  if (src === 'landing_moteurs') return 'moteur';
  const txt = [((lead.requested || {}).ref || ''), ((lead.requested || {}).vehicle || ''),
    ...((lead.items || []).map((i) => i.name || ''))].join(' ').toLowerCase();
  if (/pont|différentiel|differentiel|transfert|haldex/.test(txt)) return 'pont';
  if (/bo[iî]te|dsg|m[ée]catronique|tcu|calculateur de bo/.test(txt)) return 'boite';
  if (/moteur/.test(txt)) return 'moteur';
  return 'autre';
}

function filtreBase(now) {
  const depuis = new Date(now.getTime() - FENETRE_JOURS * 86400000);
  return {
    archived: { $ne: true },
    manualStatus: { $nin: ['converted', 'lost'] },
    'engineQuote.status': { $nin: ['won', 'lost', 'acompte_recu'] },
    status: { $ne: 'recovered' },
    $and: [
      { $or: [
        { captureSource: { $in: SOURCES_DEMANDE } },
        { takenByName: { $nin: ['', null] } },
        { 'nextAction.dueAt': { $ne: null } },
        { manualStatus: 'contacted' },
      ] },
      { $or: [
        { abandonedAt: { $gte: depuis } },
        { createdAt: { $gte: depuis } },
        { lastActivityAt: { $gte: depuis } },
        { 'nextAction.dueAt': { $ne: null } },
      ] },
    ],
  };
}

function mediane(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Délai de PREMIÈRE action humaine sur les vraies demandes reçues ces 30
 * derniers jours, en minutes OUVRÉES. Les envois automatiques ne comptent pas.
 */
async function delaiPremiereAction(now) {
  const depuis = new Date(now.getTime() - 30 * 86400000);
  const leads = await AbandonedCart.find({
    archived: { $ne: true },
    captureSource: { $in: SOURCES_DEMANDE },
    createdAt: { $gte: depuis },
  }).select('captureSource abandonedAt createdAt communications.sens communications.auto communications.statut communications.at lastCallOutcome lastManualContactAt manualStatus manualStatusAt engineQuote.sentQuotes.sentAt recoveredOrder engineQuote.status lostReason')
    .limit(PLAFOND).lean();
  const delais = [];
  let sansAction = 0;
  leads.forEach((l) => {
    const w = computeWork(l, now);
    const recu = w.receivedAt;
    if (!recu) return;
    if (w.firstHumanAt) delais.push(ho.minutesOuvreesEntre(recu, w.firstHumanAt));
    else if (w.intent === 'opportunity') sansAction += 1;
  });
  const dansLHeure = delais.filter((m) => m <= 60).length;
  return {
    total: leads.length,
    traitees: delais.length,
    mediane: mediane(delais),
    pctDansLHeure: (delais.length + sansAction) ? Math.round((dansLHeure / (delais.length + sansAction)) * 100) : null,
  };
}

/**
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {string} [opts.qui]      '' | 'moi' | 'libre'
 * @param {string} [opts.moi]      prénom de l'admin connecté (takenByName)
 * @param {string} [opts.piece]    '' | 'pont' | 'boite' | 'moteur' | 'autre'
 * @param {string} [opts.source]   captureSource exact
 * @param {string} [opts.voir]     clé du groupe à afficher en entier
 */
async function chargerFile(opts = {}) {
  const now = opts.now || new Date();
  const docs = await AbandonedCart.find(filtreBase(now))
    .select(CHAMPS)
    .slice('notes', -1)
    .limit(PLAFOND)
    .lean();
  if (docs.length >= PLAFOND) console.warn(`[leads] file de travail : plafond de ${PLAFOND} dossiers atteint`);

  const tous = [];
  docs.forEach((lead) => {
    const work = computeWork(lead, now);
    if (work.intent !== 'opportunity' || !work.group) return;
    tous.push({ id: String(lead._id), lead, work, categorie: categorie(lead) });
  });

  /* Bandeau patron : sur TOUTE la file, avant les filtres rapides. */
  const parPersonne = {};
  let enRetard = 0;
  let jamaisPris = 0;
  let duJour = 0;
  tous.forEach((x) => {
    const w = x.work;
    const retard = w.group === 'retard' || w.group === 'anciens' || (w.group === 'nouveaux' && w.overdue);
    if (retard) {
      enRetard += 1;
      const qui = x.lead.takenByName || 'Non pris';
      parPersonne[qui] = (parPersonne[qui] || 0) + 1;
    }
    if (!w.firstHumanAt) jamaisPris += 1;
    if (!w.overdue && ['nouveaux', 'rappels', 'devis'].includes(w.group)) duJour += 1;
  });

  /* Filtres rapides. */
  const filtres = tous.filter((x) => {
    if (opts.qui === 'moi' && (x.lead.takenByName || '') !== (opts.moi || '')) return false;
    if (opts.qui === 'libre' && x.lead.takenByName) return false;
    if (opts.piece && x.categorie !== opts.piece) return false;
    if (opts.source && (x.lead.captureSource || '') !== opts.source) return false;
    return true;
  });

  const groupes = GROUPES.map((g) => {
    const items = filtres.filter((x) => x.work.group === g.key).sort(comparer);
    const toutVoir = opts.voir === g.key;
    return Object.assign({}, g, {
      count: items.length,
      items: toutVoir ? items.slice(0, 300) : items.slice(0, PAR_GROUPE),
      reste: toutVoir ? Math.max(0, items.length - 300) : Math.max(0, items.length - PAR_GROUPE),
      /* Un groupe replié s'ouvre quand on demande à le voir en entier. */
      collapsed: g.collapsed && !toutVoir,
    });
  });

  return {
    groupes,
    total: filtres.length,
    totalSansFiltre: tous.length,
    bandeau: {
      enRetard,
      jamaisPris,
      duJour,
      parPersonne: Object.keys(parPersonne).sort((a, b) => (a === 'Non pris') - (b === 'Non pris') || a.localeCompare(b))
        .map((nom) => ({ nom, n: parPersonne[nom] })),
      delai: await delaiPremiereAction(now),
    },
  };
}

module.exports = { chargerFile, categorie, PAR_GROUPE };
