'use strict';

/**
 * File de travail commerciale — « qu'est-ce que je fais maintenant ? »
 *
 * ── Le problème (constaté le 18/11/2026) ───────────────────────────────────
 *
 * - L'onglet « À traiter » de /admin/activite-panier excluait TOUS les leads
 *   des landings moteurs/boîtes/ponts (« ils ont leur pipeline en devis
 *   moteurs »). Résultat : ~200 demandes Google Ads payées jamais rappelées,
 *   197 dossiers « Nouveau » sur 200.
 * - Cliquer « Contacté » faisait sortir le client de la file : un client
 *   appelé mais pas encore décidé n'était plus suivi par personne.
 * - Rien ne disait QUOI faire ni QUAND.
 *
 * ── Le principe ─────────────────────────────────────────────────────────────
 *
 * Toute vraie demande est une affaire OUVERTE jusqu'à Gagné ou Perdu. Une
 * affaire ouverte a toujours une échéance : celle que le commercial a posée
 * (`nextAction.dueAt`), sinon une échéance déduite (60 min ouvrées pour une
 * nouvelle demande, 2 jours ouvrés après le dernier contact, 3 jours ouvrés
 * après l'envoi d'un devis). Le groupe affiché découle de cette échéance.
 *
 * `computeWork()` est une fonction PURE : mêmes champs + même `now` = même
 * résultat. Elle ne lit pas la base et n'écrit rien. Les deux pages (file de
 * travail et devis moteurs) l'utilisent, donc elles disent la même chose.
 */

const ho = require('./heuresOuvrees');
const { minuitParis } = require('./heureParis');

/** Le client a fait une DEMANDE (et non un simple passage sur le site). */
const SOURCES_DEMANDE = ['devis', 'landing_moteurs', 'landing_boites', 'landing_ponts', 'landing_5places',
  'contact', 'blog_cta', 'appel_manque', 'manual'];
/** Dossiers qui ont un atelier devis (/admin/devis-moteurs/:id). */
const SOURCES_ATELIER = ['landing_moteurs', 'landing_boites', 'landing_ponts'];

/** Une journée ouvrée = 7 h (9-12 + 14-18). */
const MIN_JOUR_OUVRE = 7 * 60;
/** Délai de première réponse à une nouvelle demande. */
const DELAI_PREMIERE_REPONSE_MIN = 60;
/** Au-delà de ce retard, le dossier passe dans « Anciens dossiers à reprendre ». */
const RETARD_ANCIEN_JOURS_OUVRES = 7;

const ETAPES = {
  nouveau:      { label: 'Nouveau',          className: 'bg-blue-100 text-blue-800' },
  en_cours:     { label: 'En cours',         className: 'bg-indigo-100 text-indigo-800' },
  devis_a_faire: { label: 'Devis à préparer', className: 'bg-orange-100 text-orange-800' },
  devis_envoye: { label: 'Devis envoyé',     className: 'bg-violet-100 text-violet-800' },
  gagne:        { label: 'Gagné',            className: 'bg-green-100 text-green-800' },
  perdu:        { label: 'Perdu',            className: 'bg-slate-200 text-slate-600' },
};

const GROUPES = [
  { key: 'nouveaux',   label: 'Nouvelles demandes',          hint: 'Première réponse dans l’heure (heures d’ouverture)', tone: 'blue',  collapsed: false },
  { key: 'retard',     label: 'En retard',                   hint: 'L’échéance est passée : à faire juste après les nouvelles demandes', tone: 'red', collapsed: false },
  { key: 'rappels',    label: 'Rappels et relances du jour', hint: 'Appels promis, devis à relancer, clients à recontacter aujourd’hui', tone: 'amber', collapsed: false },
  { key: 'devis',      label: 'Devis à préparer aujourd’hui', hint: 'Identifier la pièce, trouver le prix, envoyer le devis', tone: 'orange', collapsed: false },
  { key: 'plus_tard',  label: 'Planifiés',                   hint: 'Prévus un autre jour — rien à faire maintenant', tone: 'slate', collapsed: true },
  { key: 'anciens',    label: 'Anciens dossiers à reprendre', hint: 'En retard depuis plus de 7 jours ouvrés : à reprendre quand la file du jour est vide', tone: 'slate', collapsed: true },
];

/** Prochaines actions proposées au commercial (libellés simples). */
const TYPES_ACTION = {
  callback:     'Rappeler',
  quote:        'Préparer le devis',
  sourcing:     'Rechercher la pièce',
  follow_quote: 'Relancer le devis',
  wait_client:  'Attendre le client (infos, photos…)',
  payment:      'Vérifier le paiement',
  other:        'Autre',
};

/** Motifs de perte (obligatoires pour clôturer en « Perdu »). */
const MOTIFS_PERTE = {
  prix:          'Prix trop élevé',
  indisponible:  'Pièce indisponible',
  delai:         'Délai trop long',
  incompatible:  'Pièce incompatible',
  deja_achete:   'A acheté ailleurs',
  abandonne:     'Projet abandonné (réparé, voiture vendue…)',
  injoignable:   'Impossible à joindre',
  hors_cible:    'Pas une vraie demande (doublon, erreur, démarchage)',
  autre:         'Autre (préciser en note)',
};

/** Résultats d'appel proposés après « Appeler ». */
const RESULTATS_APPEL = {
  joint:         'Client joint',
  pas_reponse:   'Pas de réponse',
  repondeur:     'Messagerie / répondeur',
  mauvais_numero: 'Mauvais numéro',
};

function d(v) {
  if (!v) return null;
  const x = v instanceof Date ? v : new Date(v);
  return Number.isNaN(x.getTime()) ? null : x;
}

function maxDate(list) {
  let best = null;
  list.forEach((v) => { const x = d(v); if (x && (!best || x > best)) best = x; });
  return best;
}
function minDate(list) {
  let best = null;
  list.forEach((v) => { const x = d(v); if (x && (!best || x < best)) best = x; });
  return best;
}

/**
 * Premières et dernières actions HUMAINES sur le dossier. Les envois
 * automatiques (accusé de réception, « hameçon disponibilité », relances
 * panier/devis) ne comptent pas : ce ne sont pas des réponses du commercial.
 */
function actionsHumaines(lead) {
  const dates = [];
  const comms = Array.isArray(lead.communications) ? lead.communications : [];
  comms.forEach((c) => {
    if (!c || c.auto) return;
    if (c.sens === 'entrant') return;
    if (c.statut === 'echec') return;
    dates.push(c.at);
  });
  if (lead.lastCallOutcome && lead.lastCallOutcome.at) dates.push(lead.lastCallOutcome.at);
  if (lead.lastManualContactAt) dates.push(lead.lastManualContactAt);
  if (lead.manualStatus === 'contacted' && lead.manualStatusAt) dates.push(lead.manualStatusAt);
  const eq = lead.engineQuote || {};
  (Array.isArray(eq.sentQuotes) ? eq.sentQuotes : []).forEach((q) => { if (q && q.sentAt) dates.push(q.sentAt); });
  return { premiere: minDate(dates), derniere: maxDate(dates), nombre: dates.length };
}

function dernierDevisEnvoye(lead) {
  const eq = lead.engineQuote || {};
  const list = Array.isArray(eq.sentQuotes) ? eq.sentQuotes : [];
  return maxDate(list.map((q) => q && q.sentAt));
}

/** Gagné / perdu / ouvert, à partir des statuts existants (crons, webhooks, boutons). */
function issue(lead) {
  const eqs = (lead.engineQuote && lead.engineQuote.status) || '';
  const commande = lead.recoveredOrder && (lead.recoveredOrder.orderId || lead.recoveredOrder.number);
  if (commande || eqs === 'acompte_recu' || eqs === 'won' || lead.manualStatus === 'converted' || lead.status === 'recovered') return 'gagne';
  if (lead.manualStatus === 'lost' || eqs === 'lost') return 'perdu';
  return '';
}

/**
 * Le client peut-il être APPELÉ ? Depuis le 11/08/2026, appeler un particulier
 * sans son accord est du démarchage interdit — sauf pour répondre à SA
 * demande. Règle simple : on propose l'appel quand le client a fait une
 * demande (ou nous a appelés), jamais sur un simple panier ou une newsletter.
 */
function peutAppeler(lead) {
  if (!lead.phone) return false;
  if (SOURCES_DEMANDE.includes(lead.captureSource || '')) return true;
  /* Un panier dont le client a déjà été joint (il a donc échangé avec nous)
     peut être rappelé pour la suite de cet échange. */
  return !!(lead.lastCallOutcome && lead.lastCallOutcome.outcome === 'joint');
}

/**
 * Le dossier entre-t-il dans la file de travail ?
 * - 'opportunity' : vraie demande, ou dossier déjà pris en main ;
 * - 'weak'        : simple passage (panier, newsletter, compte) jamais travaillé ;
 * - 'closed'      : gagné ou perdu ;
 * - 'archived'    : rangé (robots, dossiers archivés).
 */
function intention(lead) {
  if (lead.archived) return 'archived';
  if (issue(lead)) return 'closed';
  if (SOURCES_DEMANDE.includes(lead.captureSource || '')) return 'opportunity';
  const pris = !!(lead.takenByName || (lead.nextAction && lead.nextAction.dueAt) || lead.manualStatus === 'contacted'
    || (lead.lastCallOutcome && lead.lastCallOutcome.at));
  return pris ? 'opportunity' : 'weak';
}

/** Étape visible par l'employé. */
function etape(lead, humain) {
  const fin = issue(lead);
  if (fin) return fin;
  const eqs = (lead.engineQuote && lead.engineQuote.status) || '';
  if (eqs === 'quote_sent' || dernierDevisEnvoye(lead)) return 'devis_envoye';
  const na = (lead.nextAction && lead.nextAction.type) || '';
  if (eqs === 'analyzing' || na === 'quote' || na === 'sourcing') return 'devis_a_faire';
  if (!humain.premiere) return 'nouveau';
  return 'en_cours';
}

function debutJour(now) { return minuitParis(now, 0); }
function finJour(now) { return minuitParis(now, 1); }

/**
 * @param {object} lead document AbandonedCart (lean)
 * @param {Date}   [now]
 * @returns {{
 *   intent: string, stage: string, stageLabel: string, stageClass: string,
 *   group: string, dueAt: Date|null, dueSource: string, overdue: boolean,
 *   overdueMinutes: number, primaryAction: string, primaryLabel: string,
 *   canCall: boolean, hasWorkshop: boolean, firstHumanAt: Date|null,
 *   lastHumanAt: Date|null, receivedAt: Date|null, nextActionLabel: string
 * }}
 */
function computeWork(lead, now = new Date()) {
  const l = lead || {};
  const intent = intention(l);
  const humain = actionsHumaines(l);
  const stage = etape(l, humain);
  const recu = d(l.abandonedAt) || d(l.createdAt) || d(l.lastActivityAt);
  const hasWorkshop = SOURCES_ATELIER.includes(l.captureSource || '') || !!(l.engineQuote && l.engineQuote.status);
  const canCall = peutAppeler(l);

  /* Échéance : celle du commercial, sinon déduite. */
  let dueAt = null;
  let dueSource = '';
  const na = l.nextAction || {};
  if (stage !== 'gagne' && stage !== 'perdu') {
    if (d(na.dueAt)) { dueAt = d(na.dueAt); dueSource = 'planifiee'; }
    else if (stage === 'nouveau' && recu) { dueAt = ho.ajouterMinutesOuvrees(recu, DELAI_PREMIERE_REPONSE_MIN); dueSource = 'premiere_reponse'; }
    else if (stage === 'devis_envoye') {
      const envoi = dernierDevisEnvoye(l) || humain.derniere || recu;
      if (envoi) { dueAt = ho.ajouterJoursOuvres(envoi, 3); dueSource = 'relance_devis'; }
    } else {
      const base = humain.derniere || d(l.manualStatusAt) || recu;
      if (base) { dueAt = ho.ajouterJoursOuvres(base, stage === 'devis_a_faire' ? 1 : 2); dueSource = 'suivi'; }
    }
  }

  const overdue = !!(dueAt && dueAt.getTime() < now.getTime());
  const overdueMinutes = overdue ? ho.minutesOuvreesEntre(dueAt, now) : 0;

  /* Groupe dans la file. */
  let group = '';
  if (intent === 'opportunity') {
    const age = recu ? ho.minutesOuvreesEntre(recu, now) : Infinity;
    if (stage === 'nouveau' && age <= MIN_JOUR_OUVRE) group = 'nouveaux';
    else if (overdue && overdueMinutes > RETARD_ANCIEN_JOURS_OUVRES * MIN_JOUR_OUVRE) group = 'anciens';
    else if (overdue) group = 'retard';
    else if (dueAt && dueAt < finJour(now) && dueAt >= debutJour(now)) group = stage === 'devis_a_faire' ? 'devis' : 'rappels';
    else if (dueAt && dueAt < debutJour(now)) group = 'retard';
    else group = 'plus_tard';
  }

  /* Bouton principal. */
  let primaryAction = 'plan';
  let primaryLabel = 'Planifier la suite';
  const naType = na.type || '';
  if (stage === 'gagne' || stage === 'perdu') { primaryAction = 'detail'; primaryLabel = 'Voir le dossier'; }
  else if (group === 'anciens') {
    /* Vieux dossier : d'abord relire ce qui s'est passé, puis décider
       (rappeler ou clôturer) — pas d'appel à l'aveugle. */
    primaryAction = 'review'; primaryLabel = 'Reprendre le dossier';
  }
  else if (stage === 'nouveau') {
    if (canCall) { primaryAction = 'call'; primaryLabel = 'Appeler'; }
    else if (l.email) { primaryAction = 'email'; primaryLabel = 'Répondre par email'; }
  } else if (naType === 'quote' || naType === 'sourcing' || stage === 'devis_a_faire') {
    if (hasWorkshop) { primaryAction = 'workshop'; primaryLabel = naType === 'sourcing' ? 'Rechercher la pièce' : 'Préparer le devis'; }
    else if (l.email) { primaryAction = 'email'; primaryLabel = 'Envoyer le devis'; }
  } else if (naType === 'payment') { primaryAction = 'detail'; primaryLabel = 'Vérifier le paiement'; }
  else if (canCall) { primaryAction = 'call'; primaryLabel = stage === 'devis_envoye' ? 'Relancer (appel)' : 'Rappeler'; }
  else if (l.email) { primaryAction = 'email'; primaryLabel = stage === 'devis_envoye' ? 'Relancer par email' : 'Écrire au client'; }

  const nextActionLabel = naType ? (TYPES_ACTION[naType] || naType)
    : dueSource === 'premiere_reponse' ? 'Première réponse au client'
      : dueSource === 'relance_devis' ? 'Relancer le devis'
        : dueSource === 'suivi' ? (stage === 'devis_a_faire' ? 'Préparer le devis' : 'Faire le point avec le client')
          : '';

  const meta = ETAPES[stage] || ETAPES.en_cours;
  return {
    intent,
    stage,
    stageLabel: meta.label,
    stageClass: meta.className,
    group,
    dueAt,
    dueSource,
    overdue,
    overdueMinutes,
    primaryAction,
    primaryLabel,
    canCall,
    hasWorkshop,
    firstHumanAt: humain.premiere,
    lastHumanAt: humain.derniere,
    receivedAt: recu,
    nextActionLabel,
  };
}

/** Tri dans un groupe : l'échéance la plus urgente d'abord. */
function comparer(a, b) {
  const ta = a.work.dueAt ? a.work.dueAt.getTime() : Infinity;
  const tb = b.work.dueAt ? b.work.dueAt.getTime() : Infinity;
  if (a.work.group === 'retard' && b.work.group === 'retard') {
    /* Retards récents d'abord (on sauve ce qui peut encore l'être), par
       tranches : moins d'un jour ouvré, puis le reste ; dans la tranche,
       l'échéance la plus ancienne. */
    const tra = a.work.overdueMinutes <= MIN_JOUR_OUVRE ? 0 : 1;
    const trb = b.work.overdueMinutes <= MIN_JOUR_OUVRE ? 0 : 1;
    if (tra !== trb) return tra - trb;
  }
  if (ta !== tb) return ta - tb;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/** Libellé d'urgence affiché en tête de carte (« En retard de 2 h », « Avant 10:15 »…). */
function libelleUrgence(work, now = new Date()) {
  if (!work || !work.dueAt) return '';
  const heure = work.dueAt.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  if (work.overdue) {
    const m = work.overdueMinutes;
    if (m < 60) return `En retard de ${Math.max(1, m)} min`;
    if (m < MIN_JOUR_OUVRE) return `En retard de ${Math.round(m / 60)} h`;
    const j = Math.round(m / MIN_JOUR_OUVRE);
    return `En retard de ${j} jour${j > 1 ? 's' : ''} ouvré${j > 1 ? 's' : ''}`;
  }
  if (work.dueAt < finJour(now)) return work.stage === 'nouveau' ? `À rappeler avant ${heure}` : `Aujourd’hui ${heure}`;
  const jour = work.dueAt.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' });
  return `Prévu ${jour} ${heure}`;
}

module.exports = {
  computeWork,
  comparer,
  libelleUrgence,
  actionsHumaines,
  peutAppeler,
  intention,
  SOURCES_DEMANDE,
  SOURCES_ATELIER,
  ETAPES,
  GROUPES,
  TYPES_ACTION,
  MOTIFS_PERTE,
  RESULTATS_APPEL,
  MIN_JOUR_OUVRE,
};
