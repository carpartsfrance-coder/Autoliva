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
 * ── Ce que la file a de nouveau appris (20/11/2026) ─────────────────────────
 *
 * Un dossier déjà appelé ressortait en ROUGE « En retard » deux jours ouvrés
 * plus tard, sans que personne ait décidé de cette date : c'est la file qui
 * la déduisait. Le commercial lisait un reproche sur un dossier qu'il avait
 * fait, et comme ça arrivait des centaines de fois (168 « en retard » un
 * mardi matin), il a cessé de lire le rouge — qui ne voulait plus rien dire.
 *
 * D'où la règle : une ÉCHÉANCE N'EST PAS UNE PROMESSE.
 *   - promesse (rouge, « En retard ») : une heure qu'un humain a posée
 *     (`nextAction.dueAt`), ou la première réponse due dans l'heure ;
 *   - supposition (ambre, « À relancer ») : l'échéance déduite du dernier
 *     contact. Rien ne disparaît, mais le rouge redevient un signal.
 *
 * ── Une seule pile de demandes à prendre (20/11/2026) ──────────────────────
 *
 * « Nouvelles demandes » et « En retard » séparaient deux piles que le
 * commercial traite du même geste : décrocher le téléphone. Une demande de
 * 9 h 05 et une de 8 h 40 ne demandent pas un travail différent — la seconde
 * a juste passé l'heure. Elles sont réunies dans « Non traités » : TOUT ce
 * que personne n'a encore appelé ni écrit, le plus récent en haut (un lead
 * frais se transforme bien mieux qu'un lead de la veille), avec une bascule
 * pour repartir des plus anciens.
 *
 * « En retard » redevient alors ce que son nom dit : les rendez-vous qu'on
 * avait promis sur des dossiers DÉJÀ pris en main, et qu'on a ratés.
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
  { key: 'repondu',    label: 'Le client a répondu',         hint: 'Il nous a écrit depuis notre dernier message : la balle est dans notre camp', tone: 'green', collapsed: false },
  { key: 'non_traites', label: 'Non traités',                hint: 'Personne n’a encore appelé ni écrit. Les plus récentes en haut : un lead frais se transforme bien mieux qu’un lead de la veille', tone: 'blue',  collapsed: false },
  { key: 'retard',     label: 'En retard',                   hint: 'Un rendez-vous PROMIS est passé, sur un dossier déjà pris en main : rappel planifié non tenu', tone: 'red', collapsed: false },
  { key: 'rappels',    label: 'Prévus aujourd’hui',          hint: 'Les rappels et relances que quelqu’un a planifiés pour aujourd’hui', tone: 'amber', collapsed: false },
  { key: 'devis',      label: 'Devis à préparer',            hint: 'Identifier la pièce, trouver le prix, envoyer le devis — les plus en retard en haut', tone: 'orange', collapsed: false },
  { key: 'relances',   label: 'À relancer',                  hint: 'Sans nouvelles depuis plus de 2 jours ouvrés. Personne n’a promis cette date : c’est la file qui la propose', tone: 'amber', collapsed: false },
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
  /* Un même geste est souvent inscrit deux fois (`lastManualContactAt` et
     `manualStatusAt` portent la même minute) : sans ce dédoublonnage, deux
     appels s'affichaient « contacté 4× » sur la ligne. */
  const minutes = new Set();
  dates.forEach((v) => { const x = d(v); if (x) minutes.add(Math.floor(x.getTime() / 60000)); });
  return { premiere: minDate(dates), derniere: maxDate(dates), nombre: minutes.size };
}

/**
 * Demandes d'arrêt : « STOP », « désabonnement »… Une personne qui demande
 * qu'on la laisse tranquille ne doit surtout pas remonter en tête de la file
 * des gens à rappeler. Ce n'est pas une réponse commerciale.
 */
const ARRET = /^\s*(stop\s?(sms)?|arr[eê]t\w*|stopper|d[ée]sabonn\w*|unsubscribe|ne plus)\b/i;

/**
 * Dernier message REÇU du client (SMS Ringover aujourd'hui, un autre canal
 * demain). C'est le signal le plus chaud de la file : quelqu'un qui écrit
 * attend une réponse, et il a déjà dit ce qu'il veut.
 */
function derniereReponse(lead) {
  const comms = Array.isArray(lead.communications) ? lead.communications : [];
  let best = null;
  comms.forEach((c) => {
    if (!c || c.sens !== 'entrant') return;
    if (ARRET.test(String(c.corps || ''))) return;
    const t = d(c.at);
    if (t && (!best || t > d(best.at))) best = c;
  });
  return best;
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
  /* Un panier abandonné dont le client NOUS ÉCRIT n'est plus un simple
     passage : il demande quelque chose. */
  const pris = !!(lead.takenByName || (lead.nextAction && lead.nextAction.dueAt) || lead.manualStatus === 'contacted'
    || (lead.lastCallOutcome && lead.lastCallOutcome.at) || derniereReponse(lead));
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

  /* La balle est dans NOTRE camp : le client a écrit après notre dernier
     geste (ou avant qu'on en fasse un). Tant qu'on ne lui a pas répondu, ce
     dossier passe avant tout le reste, quelle que soit son échéance. */
  const reponse = derniereReponse(l);
  const reponseAt = reponse ? d(reponse.at) : null;
  const aRepondu = !!(reponseAt && (!humain.derniere || reponseAt > humain.derniere));

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

  /* L'heure a-t-elle été POSÉE par quelqu'un, ou devinée par la file ?
     Seule une heure posée (ou la première réponse due dans l'heure, qui est
     la promesse commerciale de la maison) peut être « en retard ». */
  const promesse = dueSource === 'planifiee' || dueSource === 'premiere_reponse';
  /* Depuis combien de temps le client n'a plus de nouvelles de nous : c'est
     CE chiffre qui justifie une relance, pas le retard sur une heure que
     personne n'a choisie. */
  const sansNouvellesMin = humain.derniere ? ho.minutesOuvreesEntre(humain.derniere, now) : -1;

  const overdue = !!(dueAt && dueAt.getTime() < now.getTime());
  const overdueMinutes = overdue ? ho.minutesOuvreesEntre(dueAt, now) : 0;
  /* « Vieux retard » est un FAIT du dossier, pas une place dans la liste : le
     bandeau du patron comptait les retards par groupe, donc un dossier sorti
     de son groupe (parce que le client a répondu) disparaissait du compteur. */
  const ancien = overdue && overdueMinutes > RETARD_ANCIEN_JOURS_OUVRES * MIN_JOUR_OUVRE;

  /* Groupe dans la file. */
  let group = '';
  if (intent === 'opportunity') {
    if (aRepondu) group = 'repondu';
    /* Pas encore pris en main = une seule pile, quel que soit le retard :
       c'est le même geste pour le commercial, décrocher le téléphone.
       Au-delà de 7 jours ouvrés de retard, « Anciens dossiers » garde son
       rôle de garde-fou : la file du jour ne doit pas se noyer dedans. */
    else if (ancien) group = 'anciens';
    else if (!humain.premiere) group = 'non_traites';
    /* Un devis dû reste un devis dû, en retard ou non : le commercial veut
       les voir ensemble, les plus vieux en haut (voir comparer()). */
    else if (stage === 'devis_a_faire' && dueAt && dueAt < finJour(now)) group = 'devis';
    else if (overdue) group = promesse ? 'retard' : 'relances';
    else if (dueAt && dueAt < finJour(now) && dueAt >= debutJour(now)) group = 'rappels';
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

  const nextActionLabel = aRepondu ? 'Répondre au client'
    : naType ? (TYPES_ACTION[naType] || naType)
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
    promesse,
    sansNouvellesMin,
    ancien,
    aRepondu,
    reponseAt,
    reponseCanal: (reponse && reponse.canal) || '',
    reponseTexte: (reponse && reponse.corps) || '',
    primaryAction,
    primaryLabel,
    canCall,
    hasWorkshop,
    firstHumanAt: humain.premiere,
    lastHumanAt: humain.derniere,
    nombreHumain: humain.nombre,
    receivedAt: recu,
    nextActionLabel,
  };
}

/** Tri dans un groupe : l'échéance la plus urgente d'abord. */
function comparer(a, b) {
  /* « Non traités » : l'échéance ne distingue rien, elles sont toutes à
     « une heure après l'arrivée ». Ce qui compte est la FRAÎCHEUR — un lead
     de 9 h 05 se transforme bien mieux qu'un lead d'hier soir. La file
     renverse cet ordre quand on demande les plus anciens d'abord. */
  if (a.work.group === 'non_traites' && b.work.group === 'non_traites') {
    const ra = a.work.receivedAt ? a.work.receivedAt.getTime() : 0;
    const rb = b.work.receivedAt ? b.work.receivedAt.getTime() : 0;
    if (ra !== rb) return rb - ra;
    return String(a.id || '').localeCompare(String(b.id || ''));
  }
  /* Dans « Le client a répondu », l'échéance ne veut plus rien dire : ce qui
     compte est depuis quand son message attend une réponse. */
  if (a.work.group === 'repondu' && b.work.group === 'repondu') {
    const ra = a.work.reponseAt ? a.work.reponseAt.getTime() : Infinity;
    const rb = b.work.reponseAt ? b.work.reponseAt.getTime() : Infinity;
    if (ra !== rb) return ra - rb;
    return String(a.id || '').localeCompare(String(b.id || ''));
  }
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

/** Durée ouvrée en toutes lettres : « 45 min », « 3 h », « 4 jours ouvrés ». */
function duree(minutes, court = false) {
  const m = Math.max(1, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} min`;
  if (m < MIN_JOUR_OUVRE) return `${Math.round(m / 60)} h`;
  const j = Math.round(m / MIN_JOUR_OUVRE);
  return court ? `${j} j` : `${j} jour${j > 1 ? 's' : ''} ouvré${j > 1 ? 's' : ''}`;
}

/**
 * Libellé d'urgence affiché en tête de carte. Une heure que personne n'a
 * promise ne produit JAMAIS un « en retard » : elle dit depuis combien de
 * temps le client n'a plus de nouvelles, ce qui est le vrai motif de relance.
 */
function libelleUrgence(work, now = new Date()) {
  if (!work || !work.dueAt) return '';
  const heure = work.dueAt.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  if (work.overdue && !work.promesse) {
    const quoi = work.stage === 'devis_a_faire' ? 'Devis à préparer' : 'À relancer';
    return work.sansNouvellesMin >= 0
      ? `${quoi} — sans nouvelles depuis ${duree(work.sansNouvellesMin)}`
      : `${quoi} — échéance dépassée de ${duree(work.overdueMinutes)}`;
  }
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

/**
 * Version courte pour la liste de gauche (« Retard 2 h », « Avant 10:15 »,
 * « 14:00 », « jeu. 20/11 ») : la ligne n'a la place que pour quelques mots.
 */
function libelleUrgenceCourt(work, now = new Date()) {
  if (!work || !work.dueAt) return '';
  const heure = work.dueAt.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  if (work.overdue && !work.promesse) {
    const quoi = work.stage === 'devis_a_faire' ? 'Devis' : 'Relancer';
    return `${quoi} · ${duree(work.sansNouvellesMin >= 0 ? work.sansNouvellesMin : work.overdueMinutes, true)}`;
  }
  if (work.overdue) {
    const m = work.overdueMinutes;
    if (m < 60) return `Retard ${Math.max(1, m)} min`;
    if (m < MIN_JOUR_OUVRE) return `Retard ${Math.round(m / 60)} h`;
    return `Retard ${Math.round(m / MIN_JOUR_OUVRE)} j`;
  }
  if (work.dueAt < finJour(now)) return work.stage === 'nouveau' ? `Avant ${heure}` : heure;
  return work.dueAt.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit' });
}

module.exports = {
  computeWork,
  duree,
  derniereReponse,
  comparer,
  libelleUrgence,
  libelleUrgenceCourt,
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
