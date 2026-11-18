'use strict';

/**
 * Actions de la file de travail commerciale (/admin/activite-panier) :
 *   POST /admin/api/leads/:id/prendre         « Je m'en occupe »
 *   POST /admin/api/leads/:id/appel           résultat d'un appel + suite
 *   POST /admin/api/leads/:id/prochaine-action planifier la suite
 *   POST /admin/api/leads/:id/cloturer        Gagné / Perdu (motif obligatoire)
 *   GET  /admin/api/leads/file/nouveautes     ce qui est arrivé depuis l'affichage
 *   POST /admin/api/leads/lot                 même action sur plusieurs dossiers
 *
 * Règle d'or : une affaire ouverte n'est JAMAIS laissée sans prochaine action.
 * Chaque action enregistre aussi une note lisible dans l'historique du lead.
 * Le calcul de l'étape et du groupe est fait par services/leadWork.js.
 */

const mongoose = require('mongoose');
const AbandonedCart = require('../models/AbandonedCart');
const ho = require('../services/heuresOuvrees');
const { minuitParis } = require('../services/heureParis');
const { TYPES_ACTION, MOTIFS_PERTE, RESULTATS_APPEL, computeWork, libelleUrgence, SOURCES_DEMANDE } = require('../services/leadWork');

function admin(req) {
  const a = (req && req.session && req.session.admin) || {};
  const rawId = a.adminUserId || a._id || '';
  return {
    id: rawId && mongoose.Types.ObjectId.isValid(rawId) ? new mongoose.Types.ObjectId(rawId) : null,
    /* « Pris par Faniry » : le prénom suffit dans une équipe de trois. */
    court: (a.firstName || '').trim() || ((a.firstName || '') + ' ' + (a.lastName || '')).trim() || a.email || 'Admin',
    nom: ((a.firstName || '') + ' ' + (a.lastName || '')).trim() || a.email || 'Admin',
  };
}

function idValide(req, res) {
  if (mongoose.connection.readyState !== 1) { res.status(503).json({ ok: false, error: 'Base de données indisponible.' }); return null; }
  const id = req.params.id;
  if (!id || !mongoose.Types.ObjectId.isValid(id)) { res.status(400).json({ ok: false, error: 'Dossier introuvable.' }); return null; }
  return id;
}

function fmtQuand(date) {
  return new Date(date).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Instant à `h`:`m` (heure de Paris) le jour parisien de `date`. */
function aHeureParis(date, h, m = 0) {
  return new Date(minuitParis(date, 0).getTime() + (h * 60 + m) * 60000);
}

/**
 * Échéance à partir d'un raccourci ou d'une date saisie. Les raccourcis sont
 * en temps OUVRÉ : « demain » un vendredi veut dire lundi.
 *   1h, 2h   → dans 1 h / 2 h ouvrées
 *   aprem    → cet après-midi 14 h (ou le prochain après-midi ouvré)
 *   demain   → prochain jour ouvré, 9 h 30
 *   2j, 5j   → dans 2 / 5 jours ouvrés, 9 h 30
 *   ISO      → la date saisie (refusée si elle est passée)
 */
function echeance(raw, now = new Date()) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (v === '1h') return ho.ajouterMinutesOuvrees(now, 60);
  if (v === '2h') return ho.ajouterMinutesOuvrees(now, 120);
  if (v === 'aprem') {
    const cetAprem = aHeureParis(now, 14);
    if (ho.jourOuvre(now) && now.getTime() < cetAprem.getTime()) return cetAprem;
    return aHeureParis(ho.ajouterJoursOuvres(now, 1), 14);
  }
  const jours = { demain: 1, '2j': 2, '5j': 5 }[v];
  if (jours) return aHeureParis(ho.ajouterJoursOuvres(now, jours), 9, 30);
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) return null;
  /* Une date passée n'a pas de sens pour une prochaine action. */
  if (date.getTime() < now.getTime() - 5 * 60000) return null;
  return date;
}

/** Réponse commune : l'état recalculé du dossier, pour mettre la carte à jour sans recharger. */
async function etatApres(id) {
  const lead = await AbandonedCart.findById(id).lean();
  if (!lead) return null;
  const w = computeWork(lead);
  return {
    stage: w.stage,
    stageLabel: w.stageLabel,
    group: w.group,
    urgence: libelleUrgence(w),
    dueAt: w.dueAt,
    nextActionLabel: w.nextActionLabel,
    takenByName: lead.takenByName || '',
  };
}

/** POST /admin/api/leads/:id/prendre  { force } */
async function postPrendre(req, res, next) {
  try {
    const id = idValide(req, res);
    if (!id) return undefined;
    const moi = admin(req);
    const now = new Date();
    const force = req.body && (req.body.force === true || req.body.force === '1' || req.body.force === 'true');

    /* Atomique : si deux personnes cliquent en même temps, une seule gagne.
       Reprendre le dossier d'un collègue demande une confirmation (force). */
    const filtre = { _id: id };
    if (!force) filtre.$or = [{ takenByName: '' }, { takenByName: null }, { takenByName: { $exists: false } }, { takenByName: moi.court }];
    const r = await AbandonedCart.updateOne(filtre, {
      $set: { takenBy: moi.id, takenByName: moi.court, takenAt: now },
      $push: { notes: { text: `Dossier pris en charge par ${moi.court}`, addedBy: moi.id, addedByName: moi.nom, addedAt: now } },
    });
    if (!r.matchedCount) {
      const lead = await AbandonedCart.findById(id).select('takenByName').lean();
      if (!lead) return res.status(404).json({ ok: false, error: 'Dossier introuvable.' });
      return res.status(409).json({ ok: false, error: `Déjà pris par ${lead.takenByName}.`, takenByName: lead.takenByName });
    }
    return res.json({ ok: true, takenByName: moi.court, etat: await etatApres(id) });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/api/leads/:id/appel
 * { resultat: joint|pas_reponse|repondeur|mauvais_numero,
 *   suite: callback|quote|sourcing|wait_client|payment|other|perdu,
 *   quand: '2h'|'demain'|ISO, note, motif }
 *
 * « J'ai appelé » ne peut PAS être enregistré sans résultat ni suite : c'est
 * ce qui empêchait le suivi (« Contacté » faisait sortir le client de la file).
 */
async function postAppel(req, res, next) {
  try {
    const id = idValide(req, res);
    if (!id) return undefined;
    const b = req.body || {};
    const resultat = String(b.resultat || '');
    if (!RESULTATS_APPEL[resultat]) return res.status(400).json({ ok: false, error: 'Choisis le résultat de l’appel.' });

    const moi = admin(req);
    const now = new Date();
    const note = String(b.note || '').trim().slice(0, 1000);
    let suite = String(b.suite || '');
    let quand = echeance(b.quand, now);

    /* Pas joint : la suite est évidente, on la pose sans rien demander.
       1er essai → rappel dans 2 h ouvrées ; essais suivants → lendemain. */
    if (resultat !== 'joint' && !suite) {
      suite = resultat === 'mauvais_numero' ? 'other' : 'callback';
    }
    if (resultat !== 'joint' && !quand) {
      const lead0 = await AbandonedCart.findById(id).select('lastCallOutcome').lean();
      const dejaEssaye = lead0 && lead0.lastCallOutcome && ['pas_reponse', 'repondeur'].includes(lead0.lastCallOutcome.outcome);
      quand = resultat === 'mauvais_numero' ? ho.ajouterMinutesOuvrees(now, 30)
        : dejaEssaye ? echeance('demain', now) : ho.ajouterMinutesOuvrees(now, 120);
    }

    const perdu = suite === 'perdu';
    if (perdu && !MOTIFS_PERTE[b.motif]) return res.status(400).json({ ok: false, error: 'Choisis le motif de perte.' });
    if (!perdu && !TYPES_ACTION[suite]) return res.status(400).json({ ok: false, error: 'Choisis la suite à donner.' });
    if (!perdu && !quand) return res.status(400).json({ ok: false, error: 'Choisis quand faire la suite.' });

    const lead = await AbandonedCart.findById(id).select('_id manualStatus takenByName captureSource engineQuote.status').lean();
    if (!lead) return res.status(404).json({ ok: false, error: 'Dossier introuvable.' });

    const set = {
      lastCallOutcome: { outcome: resultat, at: now, byName: moi.court },
      lastManualContactAt: now,
    };
    /* Compatibilité : « Contacté » reste posé comme avant (il coupe les
       relances panier automatiques), mais la PROCHAINE ACTION garde le client
       dans la file. */
    if (!lead.manualStatus) {
      set.manualStatus = 'contacted';
      set.manualStatusBy = moi.id;
      set.manualStatusByName = moi.nom;
      set.manualStatusAt = now;
    }
    if (!lead.takenByName) { set.takenBy = moi.id; set.takenByName = moi.court; set.takenAt = now; }

    let texte = `📞 Appel — ${RESULTATS_APPEL[resultat]}`;
    if (perdu) {
      set.manualStatus = 'lost';
      set.manualStatusBy = moi.id;
      set.manualStatusByName = moi.nom;
      set.manualStatusAt = now;
      set.lostReason = b.motif;
      set.nextAction = { type: '', dueAt: null, note: '', setByName: moi.court, setAt: now };
      /* Même règle que « Perdu… » : le dossier devis suit, sinon il resterait
         ouvert dans la page Devis moteurs. */
      if (lead.engineQuote && lead.engineQuote.status && !['won', 'acompte_recu'].includes(lead.engineQuote.status)) {
        set['engineQuote.status'] = 'lost';
      }
      texte += ` → Perdu (${MOTIFS_PERTE[b.motif]})`;
    } else {
      set.nextAction = { type: suite, dueAt: quand, note, setByName: moi.court, setAt: now };
      texte += ` → ${TYPES_ACTION[suite]} ${fmtQuand(quand)}`;
    }
    if (note) texte += ` — ${note}`;

    await AbandonedCart.updateOne({ _id: id }, {
      $set: set,
      $push: { notes: { text: texte, addedBy: moi.id, addedByName: moi.nom, addedAt: now } },
    });
    return res.json({ ok: true, message: texte.replace(/^📞 /, ''), etat: await etatApres(id) });
  } catch (err) {
    return next(err);
  }
}

/** POST /admin/api/leads/:id/prochaine-action  { type, quand, note } */
async function postProchaineAction(req, res, next) {
  try {
    const id = idValide(req, res);
    if (!id) return undefined;
    const b = req.body || {};
    const type = String(b.type || '');
    if (!TYPES_ACTION[type]) return res.status(400).json({ ok: false, error: 'Choisis l’action à faire.' });
    const now = new Date();
    const quand = echeance(b.quand, now);
    if (!quand) return res.status(400).json({ ok: false, error: 'Choisis quand (date à venir).' });
    const note = String(b.note || '').trim().slice(0, 1000);
    const moi = admin(req);

    const lead = await AbandonedCart.findById(id).select('_id takenByName').lean();
    if (!lead) return res.status(404).json({ ok: false, error: 'Dossier introuvable.' });
    const set = { nextAction: { type, dueAt: quand, note, setByName: moi.court, setAt: now } };
    if (!lead.takenByName) { set.takenBy = moi.id; set.takenByName = moi.court; set.takenAt = now; }

    const texte = `🗓 Prochaine action : ${TYPES_ACTION[type]} — ${fmtQuand(quand)}${note ? ' — ' + note : ''}`;
    await AbandonedCart.updateOne({ _id: id }, {
      $set: set,
      $push: { notes: { text: texte, addedBy: moi.id, addedByName: moi.nom, addedAt: now } },
    });
    return res.json({ ok: true, message: texte.replace(/^🗓 /, ''), etat: await etatApres(id) });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/api/leads/:id/cloturer  { issue: gagne|perdu|rouvrir, motif, confirme }
 * - Gagné : seulement si le client a PAYÉ (commande, acompte, virement,
 *   espèces) — une case à cocher le fait confirmer. Les paiements Mollie et les
 *   commandes rapprochées passent en gagné tout seuls, sans ce bouton.
 * - Perdu : motif obligatoire (sinon on ne saura jamais pourquoi on perd).
 * - Rouvrir : annule une clôture faite par erreur.
 */
async function postCloturer(req, res, next) {
  try {
    const id = idValide(req, res);
    if (!id) return undefined;
    const b = req.body || {};
    const choix = String(b.issue || '');
    const moi = admin(req);
    const now = new Date();
    const lead = await AbandonedCart.findById(id).select('_id manualStatus recoveredOrder captureSource engineQuote.status').lean();
    if (!lead) return res.status(404).json({ ok: false, error: 'Dossier introuvable.' });

    const set = {};
    let texte = '';
    if (choix === 'gagne') {
      if (!(b.confirme === true || b.confirme === '1' || b.confirme === 'true')) {
        return res.status(400).json({ ok: false, error: 'Coche « Le client a payé ou versé un acompte ».' });
      }
      Object.assign(set, { manualStatus: 'converted', manualStatusBy: moi.id, manualStatusByName: moi.nom, manualStatusAt: now, recoveredAt: now, lostReason: '' });
      const moyen = String(b.moyen || '').trim().slice(0, 60);
      texte = '✅ Gagné — paiement confirmé par ' + moi.court + (moyen ? ' (' + moyen + ')' : '');
    } else if (choix === 'perdu') {
      if (!MOTIFS_PERTE[b.motif]) return res.status(400).json({ ok: false, error: 'Choisis le motif de perte.' });
      Object.assign(set, { manualStatus: 'lost', manualStatusBy: moi.id, manualStatusByName: moi.nom, manualStatusAt: now, lostReason: b.motif });
      /* Le dossier devis passe aussi en perdu : sinon il resterait « Nouveau »
         dans la page Devis moteurs. */
      if (lead.engineQuote && lead.engineQuote.status && !['won', 'acompte_recu'].includes(lead.engineQuote.status)) {
        set['engineQuote.status'] = 'lost';
      }
      const precision = String(b.note || '').trim().slice(0, 500);
      texte = `✖ Perdu — ${MOTIFS_PERTE[b.motif]}${precision ? ' — ' + precision : ''}`;
    } else if (choix === 'rouvrir') {
      Object.assign(set, { manualStatus: 'contacted', manualStatusBy: moi.id, manualStatusByName: moi.nom, manualStatusAt: now, lostReason: '' });
      const commandeLiee = lead.recoveredOrder && (lead.recoveredOrder.orderId || lead.recoveredOrder.number);
      if (lead.manualStatus === 'converted' && !commandeLiee) set.recoveredAt = null;
      if (lead.engineQuote && lead.engineQuote.status === 'lost') set['engineQuote.status'] = 'analyzing';
      set.nextAction = { type: 'callback', dueAt: ho.ajouterMinutesOuvrees(now, 60), note: 'Dossier rouvert', setByName: moi.court, setAt: now };
      texte = '↩ Dossier rouvert par ' + moi.court;
    } else {
      return res.status(400).json({ ok: false, error: 'Choix invalide.' });
    }
    if (choix !== 'rouvrir') set.nextAction = { type: '', dueAt: null, note: '', setByName: moi.court, setAt: now };

    await AbandonedCart.updateOne({ _id: id }, {
      $set: set,
      $push: { notes: { text: texte, addedBy: moi.id, addedByName: moi.nom, addedAt: now } },
    });
    return res.json({ ok: true, message: texte, etat: await etatApres(id) });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /admin/api/leads/file/nouveautes?depuis=ISO
 *
 * « Qu'est-ce qui est arrivé depuis que j'ai ouvert la page ? » La file est
 * rendue par le serveur : un lead qui arrive pendant qu'un commercial
 * travaille restait invisible jusqu'au prochain F5. Deux comptages, pas de
 * données personnelles : la page affiche « 3 nouvelles demandes » et propose
 * d'actualiser.
 */
async function getNouveautes(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });
    const depuis = new Date(String(req.query.depuis || ''));
    if (Number.isNaN(depuis.getTime())) return res.status(400).json({ ok: false, error: 'Date de référence invalide.' });
    /* Garde-fou : une page laissée ouverte un week-end ne doit pas compter
       trois jours d'arrivées comme « nouveautés ». */
    const plancher = new Date(Date.now() - 36 * 3600 * 1000);
    const borne = depuis < plancher ? plancher : depuis;

    const [nouvelles, reponses] = await Promise.all([
      AbandonedCart.countDocuments({
        archived: { $ne: true },
        captureSource: { $in: SOURCES_DEMANDE },
        createdAt: { $gte: borne },
      }),
      AbandonedCart.countDocuments({
        archived: { $ne: true },
        communications: { $elemMatch: { sens: 'entrant', at: { $gte: borne } } },
      }),
    ]);
    return res.json({ ok: true, nouvelles, reponses, depuis: borne.toISOString() });
  } catch (err) {
    return next(err);
  }
}

/** Au-delà, c'est un ménage de masse : il se fait en plusieurs fois, à l'œil. */
const LOT_MAX = 300;

/**
 * POST /admin/api/leads/lot  { ids: [], action: 'prendre'|'perdu', motif, note }
 *
 * « Anciens dossiers » compte des centaines de demandes mortes qu'il fallait
 * clôturer une par une : personne ne le faisait, et le groupe ne désemplissait
 * pas. Perdre en lot demande un motif, comme à l'unité — c'est ce qui permet
 * de savoir ce qui fait perdre des ventes. Rien n'est supprimé : un dossier
 * clôturé par erreur se rouvre depuis sa fiche.
 */
async function postLot(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });
    const b = req.body || {};
    const action = String(b.action || '');
    if (!['prendre', 'perdu'].includes(action)) return res.status(400).json({ ok: false, error: 'Action inconnue.' });

    const bruts = Array.isArray(b.ids) ? b.ids : [];
    const ids = [...new Set(bruts.map(String))].filter((x) => mongoose.Types.ObjectId.isValid(x));
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Aucun dossier sélectionné.' });
    if (ids.length > LOT_MAX) return res.status(400).json({ ok: false, error: `Trop de dossiers d'un coup (${ids.length}, maximum ${LOT_MAX}).` });

    const moi = admin(req);
    const now = new Date();

    if (action === 'prendre') {
      /* Seulement les dossiers que personne ne suit : on ne prend pas ceux
         d'un collègue sans le lui dire. */
      const libre = { _id: { $in: ids }, $or: [{ takenByName: '' }, { takenByName: null }, { takenByName: { $exists: false } }] };
      const r = await AbandonedCart.updateMany(libre, {
        $set: { takenBy: moi.id, takenByName: moi.court, takenAt: now },
        $push: { notes: { text: `Dossier pris en charge par ${moi.court}`, addedBy: moi.id, addedByName: moi.nom, addedAt: now } },
      });
      const n = r.modifiedCount || 0;
      const ignores = ids.length - n;
      return res.json({
        ok: true,
        modifies: n,
        message: `${n} dossier${n > 1 ? 's' : ''} pris en charge`
          + (ignores > 0 ? ` — ${ignores} déjà suivi${ignores > 1 ? 's' : ''} par quelqu'un` : ''),
      });
    }

    if (!MOTIFS_PERTE[b.motif]) return res.status(400).json({ ok: false, error: 'Choisis le motif de perte.' });
    const precision = String(b.note || '').trim().slice(0, 500);
    const texte = `✖ Perdu — ${MOTIFS_PERTE[b.motif]}${precision ? ' — ' + precision : ''} (clôture en lot par ${moi.court})`;

    /* Les dossiers déjà gagnés ne sont pas repassés en perdu par une sélection
       trop large : une vente encaissée ne se perd pas d'un clic. */
    const aClore = { _id: { $in: ids }, manualStatus: { $ne: 'converted' } };
    const r = await AbandonedCart.updateMany(aClore, {
      $set: {
        manualStatus: 'lost', manualStatusBy: moi.id, manualStatusByName: moi.nom, manualStatusAt: now,
        lostReason: b.motif,
        nextAction: { type: '', dueAt: null, note: '', setByName: moi.court, setAt: now },
      },
      $push: { notes: { text: texte, addedBy: moi.id, addedByName: moi.nom, addedAt: now } },
    });
    /* Le dossier devis suit, sinon il resterait ouvert dans Devis moteurs. */
    await AbandonedCart.updateMany({
      _id: { $in: ids },
      'engineQuote.status': { $nin: ['won', 'acompte_recu', 'lost'] },
      manualStatus: 'lost',
    }, { $set: { 'engineQuote.status': 'lost' } });

    const n = r.modifiedCount || 0;
    const ignores = ids.length - n;
    return res.json({
      ok: true,
      modifies: n,
      message: `${n} dossier${n > 1 ? 's' : ''} clôturé${n > 1 ? 's' : ''} en perdu (${MOTIFS_PERTE[b.motif]})`
        + (ignores > 0 ? ` — ${ignores} ignoré${ignores > 1 ? 's' : ''} (déjà gagné${ignores > 1 ? 's' : ''})` : ''),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { postPrendre, postAppel, postProchaineAction, postCloturer, getNouveautes, postLot, echeance, LOT_MAX };
