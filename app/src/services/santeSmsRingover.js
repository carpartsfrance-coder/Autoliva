'use strict';

/* État de santé du SMS d'accusé de réception (appel manqué → Ringover).
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * Le 25/09/2026 au matin, Ringover s'est mis à refuser tous les envois avec
 * « 403 insufficient permissions ». Le mécanisme a continué de tourner comme
 * si de rien n'était : l'appel manqué était capté, la fiche enrichie, et
 * l'envoi échouait en silence. Personne ne l'a vu pendant DIX-NEUF JOURS, et
 * 692 clients ont appelé sans jamais recevoir le message qui leur promettait
 * un rappel. Le journal des communications savait tout ; il n'était lu par
 * personne.
 *
 * Même leçon que la traduction allemande : ce qui manquait n'était pas un test,
 * c'était de rendre la panne VISIBLE là où on regarde — le tableau de bord.
 *
 * ── Ce qu'on ne compte PAS comme une panne ──────────────────────────────────
 *
 * Un numéro qui ne peut pas recevoir de SMS (ligne fixe, ou destination que
 * Ringover refuse) n'est pas un incident : c'est une limite connue, mesurée,
 * et traitée en amont par ringoverSms. La compter ici noierait la vraie panne
 * sous le bruit — c'est d'ailleurs ce qui s'est passé : avant le 25/09, le
 * journal contenait déjà des centaines de 403 pour des fixes et des numéros
 * étrangers, et ils rendaient le vrai basculement invisible.
 */

const mongoose = require('mongoose');
const ringoverSms = require('./ringoverSms');

/* Au-delà, ce n'est plus un aléa : c'est que le canal est coupé. Cinq échecs
   d'affilée, c'est une demi-journée d'appels manqués sans réponse. */
const SEUIL_ALERTE = 5;

/* On ne remonte pas plus loin : au-delà, un vieil incident déjà réglé
   fausserait le diagnostic du jour. */
const FENETRE_JOURS = 30;

/** Ce que l'échec veut dire, en français, pour quelqu'un qui doit agir. */
const EXPLICATIONS = {
  http_403: 'Ringover refuse l’envoi : la clé API n’a plus l’autorisation d’écrire '
    + '(permission « Conversations W »). Les droits d’une clé ne se modifient pas '
    + 'après coup chez Ringover : il faut en générer une nouvelle et la reporter '
    + 'dans RINGOVER_API_KEY.',
  http_401: 'Ringover refuse la clé API : elle a été révoquée ou remplacée.',
  credits_epuises: 'Crédits SMS Ringover épuisés : recharger le compte.',
  reseau: 'Ringover est injoignable depuis le serveur.',
  non_configure: 'Le canal est désarmé : RINGOVER_API_KEY ou RINGOVER_SMS_FROM manque.',
};

/* La sonde interroge Ringover : on ne la lance qu'en cas de panne, et au plus
   une fois toutes les dix minutes, pour qu'un tableau de bord rafraîchi ne
   martèle pas leur API. */
const SONDE_CACHE = { a: 0, phrase: '' };
const SONDE_DUREE_MS = 10 * 60 * 1000;

async function diagnostic() {
  /* Débrayable : les tests ne doivent pas appeler Ringover pour de vrai. */
  if (String(process.env.RINGOVER_SONDE || '').toLowerCase() === 'off') return '';
  const maintenant = Date.now();
  if (SONDE_CACHE.a && maintenant - SONDE_CACHE.a < SONDE_DUREE_MS) return SONDE_CACHE.phrase;
  const r = await ringoverSms.sonder();
  const phrase = r.ok ? ringoverSms.lireSonde(r.statut) : '';
  SONDE_CACHE.a = maintenant;
  SONDE_CACHE.phrase = phrase;
  return phrase;
}

/** Les numéros que Ringover accepte, en expression régulière, pour la base. */
function regexPerimetre() {
  const prefixes = ringoverSms.prefixesAutorises();
  if (!prefixes.length) return '.';
  return '^(' + prefixes.map((p) => p.replace('+', '\\+')).join('|') + ')';
}

function expliquer(motif) {
  if (!motif) return 'Échec sans motif enregistré.';
  return EXPLICATIONS[motif] || `Ringover a répondu « ${motif} ».`;
}

/**
 * Un seul verdict, pour ne pas avoir à interpréter cinq chiffres.
 *
 * @returns {Promise<null|{verdict:string, message:string, echecs:number,
 *   clients:number, motif:string, derniereReussite:Date|null, jours:number|null}>}
 */
async function etatSmsRingover() {
  if (mongoose.connection.readyState !== 1) return null;

  const AbandonedCart = mongoose.model('AbandonedCart');
  const depuis = new Date(Date.now() - FENETRE_JOURS * 24 * 3600 * 1000);

  /* Deux agrégations bornées, sur les seules fiches qui portent un accusé :
     le tableau de bord ne doit pas payer un balayage complet. */
  const base = [
    { $match: { 'communications.gabarit': 'ringover_accuse' } },
    { $unwind: '$communications' },
    { $match: { 'communications.gabarit': 'ringover_accuse' } },
  ];

  const [reussites, echecs] = await Promise.all([
    AbandonedCart.aggregate([
      ...base,
      { $match: { 'communications.statut': 'envoye' } },
      { $group: { _id: null, dernier: { $max: '$communications.at' } } },
    ]).option({ maxTimeMS: 4000 }),
    AbandonedCart.aggregate([
      ...base,
      {
        $match: {
          'communications.statut': 'echec',
          'communications.at': { $gte: depuis },
          /* Les destinataires hors périmètre sont écartés en amont et
             journalisés comme tels : ce ne sont pas des pannes. */
          'communications.motif': { $nin: ['destinataire_hors_perimetre', 'destinataire_invalide'] },
          /* Et pour les lignes écrites AVANT que ce tri existe : le numéro
             lui-même tranche. Sans ça, le compteur annoncerait 963 échecs là
             où 692 clients seulement pouvaient recevoir quelque chose — un
             chiffre faux dans un encart d'alerte le rend inutile.
             Un numéro absent est conservé : on ne fait pas disparaître un
             échec qu'on ne sait pas classer. */
          $or: [{ phone: { $in: [null, ''] } }, { phone: { $regex: regexPerimetre() } }],
        },
      },
      {
        $group: {
          _id: '$communications.motif',
          n: { $sum: 1 },
          clients: { $addToSet: '$_id' },
          dernier: { $max: '$communications.at' },
        },
      },
      { $sort: { n: -1 } },
    ]).option({ maxTimeMS: 4000 }),
  ]);

  const derniereReussite = (reussites[0] && reussites[0].dernier) ? new Date(reussites[0].dernier) : null;

  /* Seuls comptent les échecs postérieurs au dernier succès : ce qui précède
     a été rattrapé, et l'afficher ferait croire à une panne en cours. */
  const apres = echecs
    .map((e) => ({ ...e, dernier: new Date(e.dernier) }))
    .filter((e) => !derniereReussite || e.dernier > derniereReussite);

  const nbEchecs = apres.reduce((s, e) => s + e.n, 0);
  const clients = new Set(apres.flatMap((e) => e.clients.map(String))).size;
  const motif = apres.length ? apres[0]._id : '';
  const jours = derniereReussite
    ? Math.floor((Date.now() - derniereReussite.getTime()) / 864e5)
    : null;

  if (!ringoverSms.estActif()) {
    return {
      verdict: 'alerte',
      message: 'Aucun SMS d’accusé ne peut partir : ' + EXPLICATIONS.non_configure,
      echecs: nbEchecs, clients, couverts: 0, motif: 'non_configure', derniereReussite, jours,
    };
  }

  if (!nbEchecs) {
    return { verdict: 'ok', message: '', echecs: 0, clients: 0, couverts: 0, motif: '', derniereReussite, jours };
  }

  const depuisQuand = derniereReussite
    ? `Dernier SMS parti le ${derniereReussite.toLocaleDateString('fr-FR')}`
    : 'Aucun SMS n’est jamais parti';

  /* Combien de clients le repli Brevo a-t-il quand même prévenus ? C'est ce
     qui distingue « panne qui coûte des clients » de « panne à réparer, mais
     sans victime ». */
  const repli = await AbandonedCart.aggregate([
    { $match: { 'communications.gabarit': 'accuse_appel_repli' } },
    { $unwind: '$communications' },
    {
      $match: {
        'communications.gabarit': 'accuse_appel_repli',
        'communications.statut': 'envoye',
        'communications.at': { $gte: derniereReussite || depuis },
      },
    },
    { $count: 'n' },
  ]).option({ maxTimeMS: 4000 });
  const couverts = (repli[0] && repli[0].n) || 0;

  /* Quand Ringover refuse, on lui demande pourquoi plutôt que de supposer. */
  let sonde = '';
  if (motif === 'http_403' || motif === 'http_401') {
    try { sonde = await diagnostic(); } catch (_) { /* best-effort */ }
  }

  return {
    verdict: nbEchecs >= SEUIL_ALERTE ? 'alerte' : 'attention',
    message: `${depuisQuand}. ${expliquer(motif)}${sonde ? ' — ' + sonde : ''}`
      + (couverts ? ` En attendant, ${couverts} client(s) ont été prévenus par SMS via Brevo.` : ''),
    echecs: nbEchecs,
    clients,
    couverts,
    motif,
    derniereReussite,
    jours,
  };
}

module.exports = { etatSmsRingover, SEUIL_ALERTE, EXPLICATIONS, expliquer, regexPerimetre, diagnostic };
