'use strict';

/**
 * Journal des messages échangés avec un lead — écriture et lecture.
 *
 * ── POURQUOI CE FICHIER ─────────────────────────────────────────────────────
 *
 * « Qu'est-ce qu'on a envoyé à ce client ? » n'avait pas de réponse. L'histoire
 * était éparpillée dans cinq endroits qui ne se parlaient pas :
 *
 *   `notes[]`                      les envois manuels, en texte libre
 *   `engineQuote.sentQuotes[]`     les devis
 *   `engineQuote.remindersSent[]`  les relances de devis, type + date
 *   `repurchaseReminder.sentAt`    la relance réachat
 *   `lastRemindedAt`               les relances panier — UNE DATE, c'est tout
 *
 * La dernière est la plus parlante : les relances panier envoient un email ET
 * un SMS, et ne conservaient ni le canal, ni le contenu, ni le résultat. Le
 * SMS partait même en `.catch(() => {})` : son échec n'était écrit nulle part.
 *
 * ── DEUX FONCTIONS, DEUX RÔLES ──────────────────────────────────────────────
 *
 * `journaliser()` écrit. Elle est appelée après chaque envoi et NE LÈVE JAMAIS :
 * un journal qui casse l'envoi qu'il documente serait pire que pas de journal.
 *
 * `historique()` lit, et reconstitue le passé. Les leads existants n'ont pas de
 * `communications[]` : plutôt que de repartir d'une page blanche, on relit les
 * cinq sources ci-dessus pour rebâtir ce qui est reconstituable. Ces lignes-là
 * sont marquées `reconstitue: true` — le contenu d'origine est souvent perdu,
 * et il vaut mieux l'afficher que le laisser croire complet.
 */

const mongoose = require('mongoose');
const AbandonedCart = require('../models/AbandonedCart');

/** Le journal documente, il n'archive pas : au-delà, on tronque. */
const MAX_CORPS = 600;

/* Fenêtre de rapprochement entre une ligne reconstituée et une ligne du
   journal. Pendant la transition, un envoi manuel écrit LES DEUX (la note
   historique, que les commerciaux lisent déjà, et la communication). Sans ce
   rapprochement, chaque envoi apparaîtrait en double. */
const FENETRE_DOUBLON_MS = 90 * 1000;

/* ──────────────────────────────────────────────────────────────────────── */
/*  Écriture                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

function tronquer(s, max) {
  const v = String(s == null ? '' : s).trim();
  return v.length <= max ? v : v.slice(0, max - 1).trim() + '…';
}

/**
 * Enregistre un message sur la fiche du lead.
 *
 * @param {string|object} leadId
 * @param {object} entree
 * @param {'email'|'sms'|'whatsapp'|'appel'} entree.canal
 * @param {boolean} [entree.auto]     parti tout seul (relance, accusé) ?
 * @param {string}  [entree.objet]    objet de l'email
 * @param {string}  [entree.corps]    contenu
 * @param {string}  [entree.gabarit]  clé du gabarit employé
 * @param {boolean} [entree.ok]       false ⇒ échec
 * @param {string}  [entree.motif]    motif de l'échec
 * @param {string}  [entree.par]      qui a envoyé ('Système' si absent et auto)
 * @param {object}  [entree.meta]
 * @returns {Promise<boolean>} true si la ligne a été écrite
 */
async function journaliser(leadId, entree = {}) {
  try {
    if (!leadId || !mongoose.Types.ObjectId.isValid(String(leadId))) return false;
    if (mongoose.connection.readyState !== 1) return false;
    const canal = String(entree.canal || '').toLowerCase();
    if (!['email', 'sms', 'whatsapp', 'appel'].includes(canal)) return false;

    const auto = !!entree.auto;
    const ligne = {
      canal,
      sens: entree.sens === 'entrant' ? 'entrant' : 'sortant',
      auto,
      objet: tronquer(entree.objet, 200),
      corps: tronquer(entree.corps, MAX_CORPS),
      gabarit: tronquer(entree.gabarit, 60),
      /* `ok` non fourni ⇒ succès : la quasi-totalité des appels se font après
         un envoi réussi, et exiger le drapeau ferait passer des échecs pour
         des succès en cas d'oubli — l'inverse serait plus grave. */
      statut: entree.ok === false ? 'echec' : 'envoye',
      motif: tronquer(entree.motif, 120),
      par: tronquer(entree.par || (auto ? 'Système' : ''), 60),
      at: entree.at ? new Date(entree.at) : new Date(),
      meta: (entree.meta && typeof entree.meta === 'object') ? entree.meta : {},
    };
    if (Number.isNaN(ligne.at.getTime())) ligne.at = new Date();

    await AbandonedCart.updateOne({ _id: leadId }, { $push: { communications: ligne } });
    return true;
  } catch (err) {
    /* Silencieux côté appelant, tracé côté serveur : un envoi réussi ne doit
       pas être signalé en erreur parce que son journal a échoué. */
    console.error('[leads] journal des communications :', err && err.message ? err.message : err);
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Reconstitution du passé                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

/* Les envois manuels écrivent une note préfixée d'un émoji depuis toujours.
   C'est la seule trace des mois écoulés — on la relit plutôt que de la perdre. */
const NOTES_ENVOI = [
  { rx: /^📧\s*Email envoyé([^:]*):\s*"?([\s\S]*?)"?$/u, canal: 'email' },
  { rx: /^📱\s*SMS envoyé([^:]*):\s*"?([\s\S]*?)"?$/u, canal: 'sms' },
  { rx: /^📲\s*WhatsApp ouvert([^:]*):\s*"?([\s\S]*?)"?$/u, canal: 'whatsapp' },
  { rx: /^🔁\s*(Email réachat[\s\S]*)$/u, canal: 'email', auto: true },
];

/* Les motifs d'échec remontent des transporteurs sous forme de clés techniques.
   Un commercial doit pouvoir lire « crédits SMS épuisés » et agir, pas déchiffrer
   `credits_epuises`. Les clés inconnues sont affichées telles quelles : mieux
   vaut un motif brut qu'un motif effacé. */
const MOTIFS = {
  credits_epuises: 'Crédits SMS épuisés',
  invalid_phone: 'Numéro de téléphone invalide',
  destinataire_invalide: 'Numéro de téléphone invalide',
  destinataire_est_expediteur: 'Numéro identique au nôtre',
  non_configure: 'Service SMS non configuré',
  brevo_error: 'Refus de l’opérateur',
  reseau: 'Panne réseau au moment de l’envoi',
  disabled: 'Modèle désactivé',
  exception: 'Erreur technique',
  inconnu: 'Cause inconnue',
};

function lisible(motif) {
  const m = String(motif || '').trim();
  if (!m) return '';
  if (MOTIFS[m]) return MOTIFS[m];
  /* Les erreurs HTTP arrivent en `http_404` : on les rend parlantes sans
     avoir à énumérer tous les codes possibles. */
  const http = m.match(/^http_(\d{3})$/);
  if (http) return 'Refus du service d’envoi (code ' + http[1] + ')';
  return m;
}

const LIBELLE_RELANCE_DEVIS = {
  j3: 'Relance devis J+3', j7: 'Relance devis J+7', j14: 'Relance devis J+14',
  j14_lost: 'Relance devis perdu J+14', j21_lost: 'Relance devis perdu J+21',
  hot_pdf: 'Relance « devis consulté »', hot_pay: 'Relance « paiement entamé »',
  winback: 'Relance de reconquête',
};

function depuisNotes(cart) {
  const out = [];
  (cart.notes || []).forEach((n) => {
    const texte = String(n.text || '').trim();
    for (const modele of NOTES_ENVOI) {
      const m = texte.match(modele.rx);
      if (!m) continue;
      out.push({
        canal: modele.canal,
        sens: 'sortant',
        auto: !!modele.auto,
        objet: modele.canal === 'email' ? (m[2] || m[1] || '').trim() : '',
        corps: modele.canal === 'email' ? '' : (m[2] || m[1] || '').trim(),
        gabarit: '',
        statut: 'envoye',
        par: n.addedByName || '',
        at: n.addedAt,
        reconstitue: true,
      });
      break;
    }
  });
  return out;
}

function depuisDevis(cart) {
  const eq = cart.engineQuote;
  if (!eq) return [];
  const out = [];

  (eq.sentQuotes || []).forEach((q) => {
    const version = Number(q.version) || 1;
    out.push({
      canal: 'email', sens: 'sortant', auto: false,
      objet: 'Devis' + (version > 1 ? ' (révision ' + version + ')' : ''),
      corps: q.customMessage || '',
      gabarit: 'devis',
      statut: 'envoye',
      par: q.sentByName || '',
      at: q.sentAt,
      meta: { montant: q.sellPriceTtc || q.sellPriceHt || 0, version },
      reconstitue: true,
    });
    /* Le SMS qui accompagne le devis porte SON PROPRE résultat, y compris ses
       échecs (crédits épuisés, numéro invalide). C'est une information qu'on
       n'avait nulle part ailleurs. */
    if (q.sms && q.sms.status) {
      out.push({
        canal: 'sms', sens: 'sortant', auto: false,
        objet: '', corps: 'SMS accompagnant le devis', gabarit: 'devis',
        statut: q.sms.status === 'sent' ? 'envoye' : 'echec',
        motif: q.sms.message || q.sms.reason || '',
        par: q.sentByName || '',
        at: q.sms.at || q.sentAt,
        reconstitue: true,
      });
    }
  });

  (eq.remindersSent || []).forEach((r) => {
    out.push({
      canal: 'email', sens: 'sortant', auto: true,
      objet: LIBELLE_RELANCE_DEVIS[r.type] || ('Relance devis ' + r.type),
      corps: '', gabarit: 'relance_devis_' + r.type,
      statut: 'envoye', par: 'Système', at: r.sentAt,
      reconstitue: true,
    });
  });

  return out;
}

function depuisRelances(cart) {
  const out = [];

  if (cart.repurchaseReminder && cart.repurchaseReminder.sentAt) {
    out.push({
      canal: 'email', sens: 'sortant', auto: true,
      objet: 'Relance réachat (J+90)', corps: '', gabarit: 'reachat',
      statut: 'envoye', par: 'Système', at: cart.repurchaseReminder.sentAt,
      reconstitue: true,
    });
  }

  /* Relances panier : on ne dispose QUE de la date de la dernière. Ni le
     numéro de relance, ni le contenu, ni le SMS associé n'ont été conservés.
     On l'affiche quand même, en le disant — une date sans contenu vaut mieux
     qu'un silence qui laisse croire qu'on n'a rien envoyé. */
  if (cart.lastRemindedAt) {
    out.push({
      canal: 'email', sens: 'sortant', auto: true,
      objet: 'Relance panier abandonné',
      corps: 'Contenu non conservé — les relances panier ne journalisaient que leur date.',
      gabarit: 'relance_panier', statut: 'envoye', par: 'Système',
      at: cart.lastRemindedAt, reconstitue: true, partiel: true,
    });
  }

  if (cart.ringoverSmsSentAt) {
    out.push({
      canal: 'sms', sens: 'sortant', auto: true,
      objet: '', corps: 'Accusé de réception après appel manqué',
      gabarit: 'ringover_accuse', statut: 'envoye', par: 'Système',
      at: cart.ringoverSmsSentAt, reconstitue: true,
    });
  }

  return out;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Lecture                                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Historique complet et ordonné des messages, du plus récent au plus ancien.
 *
 * Fusionne le journal (`communications[]`) et les traces antérieures. Une
 * ligne reconstituée est écartée si le journal contient déjà un message du
 * même canal à moins de 90 secondes : pendant la transition, un envoi manuel
 * alimente les deux, et on ne veut pas l'afficher deux fois.
 *
 * Le rapprochement se fait sur (canal, temps) et non sur le contenu, parce que
 * les deux sources ne tronquent pas au même endroit. Deux messages distincts
 * du même canal à moins de 90 s sur la même fiche sont assez improbables pour
 * que le risque — masquer une ligne — soit préférable au doublon systématique.
 *
 * @returns {Array<object>} lignes normalisées, prêtes à l'affichage
 */
function historique(cart) {
  if (!cart) return [];

  const journal = (cart.communications || []).map((c) => ({
    canal: c.canal, sens: c.sens || 'sortant', auto: !!c.auto,
    objet: c.objet || '', corps: c.corps || '', gabarit: c.gabarit || '',
    statut: c.statut || 'envoye', motif: lisible(c.motif), par: c.par || '',
    at: c.at, meta: c.meta || {}, reconstitue: false,
  }));

  const reperes = journal.map((c) => ({ canal: c.canal, t: new Date(c.at).getTime() }));
  const deja = (ligne) => {
    const t = new Date(ligne.at).getTime();
    if (Number.isNaN(t)) return false;
    return reperes.some((r) => r.canal === ligne.canal && Math.abs(r.t - t) <= FENETRE_DOUBLON_MS);
  };

  const ancien = []
    .concat(depuisNotes(cart), depuisDevis(cart), depuisRelances(cart))
    .filter((l) => l.at && !Number.isNaN(new Date(l.at).getTime()))
    .filter((l) => !deja(l))
    .map((l) => Object.assign(l, { motif: lisible(l.motif) }));

  return journal.concat(ancien).sort((a, b) => new Date(b.at) - new Date(a.at));
}

/** Compteurs pour l'en-tête de la fiche. */
function resume(lignes) {
  const r = { total: 0, email: 0, sms: 0, whatsapp: 0, auto: 0, manuel: 0, echecs: 0, dernier: null };
  (lignes || []).forEach((l) => {
    r.total += 1;
    if (r[l.canal] !== undefined) r[l.canal] += 1;
    if (l.auto) r.auto += 1; else r.manuel += 1;
    if (l.statut === 'echec') r.echecs += 1;
    if (!r.dernier || new Date(l.at) > new Date(r.dernier)) r.dernier = l.at;
  });
  return r;
}

module.exports = { journaliser, historique, resume, MAX_CORPS };
