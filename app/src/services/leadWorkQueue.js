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

/**
 * Fenêtres de la file (au-delà : onglet « Tous les leads », recherche).
 *
 * Mise en ligne du 18/11/2026 : sans limite d'âge, la file affichait 2 901
 * « anciens dossiers » — des demandes d'avril à juillet que personne n'avait
 * jamais traitées (elles étaient invisibles avant). Les compteurs « En retard »
 * (3 101) ne voulaient plus rien dire. Une demande jamais rappelée depuis plus
 * de 45 jours est perdue de fait : elle reste consultable, pas à traiter.
 *  - demande jamais suivie : reçue depuis moins de 45 jours ;
 *  - dossier suivi à l'ancienne (« Contacté » sans prochaine action) :
 *    dernier contact depuis moins de 45 jours ;
 *  - dossier avec une prochaine action datée (nouveau système) : toujours.
 */
const FENETRE_DEMANDE_JOURS = 45;
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
  /* `corps` : uniquement pour lire la dernière réponse du client sur la ligne,
     et pour écarter les « STOP » de la file. Le journal tronque à 600
     caractères à l'écriture, et la file ne charge que les dossiers ouverts. */
  'communications.corps',
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
  const depuis = new Date(now.getTime() - FENETRE_DEMANDE_JOURS * 86400000);
  return {
    archived: { $ne: true },
    manualStatus: { $nin: ['converted', 'lost'] },
    'engineQuote.status': { $nin: ['won', 'lost', 'acompte_recu'] },
    status: { $ne: 'recovered' },
    $or: [
      /* Suivi avec le nouveau système : une prochaine action est posée. */
      { 'nextAction.dueAt': { $ne: null } },
      /* Vraie demande récente. */
      { captureSource: { $in: SOURCES_DEMANDE }, $or: [{ abandonedAt: { $gte: depuis } }, { createdAt: { $gte: depuis } }] },
      /* Le client NOUS a écrit récemment : il attend une réponse, quelle que
         soit la façon dont il était arrivé (un panier abandonné qui répond à
         un SMS de relance est une vraie demande, pas un passage). */
      { communications: { $elemMatch: { sens: 'entrant', at: { $gte: depuis } } } },
      /* Dossier pris en main récemment (y compris « Contacté » d'avant). */
      { takenAt: { $gte: depuis } },
      { manualStatus: 'contacted', $or: [{ manualStatusAt: { $gte: depuis } }, { lastManualContactAt: { $gte: depuis } }] },
      { 'lastCallOutcome.at': { $gte: depuis } },
    ],
  };
}

/**
 * Ordre d'affichage d'un groupe, sur la TOTALITÉ de ses dossiers.
 *
 * Appelée avant tout découpage en pages, à dessein : la bascule « plus
 * anciennes d'abord » de « Non traités » doit repartir du fond de la pile,
 * pas retourner les quinze lignes déjà à l'écran.
 */
function ordonner(items, cle, tri) {
  const ordre = items.slice().sort(comparer);
  if (cle === 'non_traites' && tri === 'ancien') ordre.reverse();
  return ordre;
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
 * @param {string} [opts.suivi]    '' | 'vierges' (jamais contactés) | 'encours'
 * @param {string} [opts.tri]      '' (plus récents d'abord) | 'ancien'
 * @param {string} [opts.voir]     clé du groupe à afficher en entier
 */
async function chargerFile(opts = {}) {
  const now = opts.now || new Date();
  const docs = await AbandonedCart.find(filtreBase(now))
    .select(CHAMPS)
    .slice('notes', -6)
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
  let aRelancer = 0;
  let anciens = 0;
  let jamaisPris = 0;
  let duJour = 0;
  tous.forEach((x) => {
    const w = x.work;
    /* Le bandeau et les onglets doivent raconter la MÊME histoire : chaque
       compteur se lit sur le groupe, sinon le patron voit « 12 en retard »
       au-dessus d'un onglet « En retard » qui en montre 3.

       « En retard » ne compte donc que ce que l'onglet contient : des
       rendez-vous promis et ratés sur des dossiers déjà pris en main. Une
       demande que personne n'a touchée, elle, est comptée en « jamais
       contactés » — c'est là qu'est son travail, pas dans un retard. */
    if (w.ancien) anciens += 1;
    else if (w.group === 'retard') enRetard += 1;
    else if (w.overdue && !w.promesse) aRelancer += 1;
    if (w.group === 'retard' || w.ancien) {
      const qui = x.lead.takenByName || 'Non pris';
      parPersonne[qui] = (parPersonne[qui] || 0) + 1;
    }
    if (!w.firstHumanAt) jamaisPris += 1;
    /* « À faire aujourd'hui » : tout ce qui n'a jamais été pris compte, en
       retard ou non — c'est le même coup de téléphone. Pour les rendez-vous
       déjà posés, seuls ceux du jour (les ratés sont comptés en retard). */
    if (w.group === 'non_traites'
      || (!w.overdue && ['rappels', 'devis'].includes(w.group))) duJour += 1;
  });

  /* Filtres rapides. */
  const filtres = tous.filter((x) => {
    if (opts.qui === 'moi' && (x.lead.takenByName || '') !== (opts.moi || '')) return false;
    if (opts.qui === 'libre' && x.lead.takenByName) return false;
    /* « Jamais contactés » : la pile de demandes vierges, que l'employé veut
       voir seule sans qu'on sorte pour autant les dossiers en cours de la
       file de tout le monde (c'est ce qui avait laissé 197 demandes mortes). */
    if (opts.suivi === 'vierges' && x.work.firstHumanAt) return false;
    if (opts.suivi === 'encours' && !x.work.firstHumanAt) return false;
    if (opts.piece && x.categorie !== opts.piece) return false;
    if (opts.source && (x.lead.captureSource || '') !== opts.source) return false;
    return true;
  });

  const groupes = GROUPES.map((g) => {
    const items = ordonner(filtres.filter((x) => x.work.group === g.key), g.key, opts.tri);
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
      /* Heures PROMISES et non tenues, hors anciens dossiers. */
      enRetard,
      /* Relances que la file propose : personne n'a promis cette date. */
      aRelancer,
      /* Les vieux retards (plus de 7 jours ouvrés) sont comptés à part : mêlés
         aux retards du jour, ils donnaient l'impression d'une file sans fin. */
      anciens,
      jamaisPris,
      duJour,
      /* Des clients qui nous ont écrit et qui attendent encore une réponse. */
      parPersonne: Object.keys(parPersonne).sort((a, b) => (a === 'Non pris') - (b === 'Non pris') || a.localeCompare(b))
        .map((nom) => ({ nom, n: parPersonne[nom] })),
      delai: await delaiPremiereAction(now),
    },
  };
}

module.exports = { chargerFile, ordonner, categorie, filtreBase, PAR_GROUPE };
