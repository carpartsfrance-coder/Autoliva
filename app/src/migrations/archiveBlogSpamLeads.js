'use strict';

/**
 * Migration ONE-SHOT : range les faux leads déposés par le robot du formulaire
 * « Conseil expert » des articles de blog (novembre 2026).
 *
 * Le 18/11/2026, 209 des 230 leads « Article blog » des 90 derniers jours
 * étaient ce robot (numéro +1, aucun véhicule, message en anglais sans
 * rapport). Ils occupaient un tiers de la file « À traiter » du commercial.
 * Le formulaire les écarte désormais à l'entrée (leadSpamFilter.signauxBlog) ;
 * cette migration range ceux qui étaient déjà en base.
 *
 * Ne touche QUE les leads :
 *   - de source « blog_cta » ;
 *   - qui réunissent les deux signaux du filtre (numéro hors des pays
 *     desservis ET aucun véhicule / VIN / plaque) ;
 *   - jamais traités : aucun statut manuel, aucun message envoyé, aucune note.
 * Un lead sur lequel quelqu'un a déjà travaillé n'est jamais rangé d'office.
 *
 * Archivé, pas supprimé (même choix que scripts/archive-spam-leads.js) : le
 * lead reste retrouvable par la recherche et restaurable.
 *
 * Idempotente + marqueur (une seule exécution). Non bloquante.
 * Appelée au démarrage (server.js) après la connexion MongoDB.
 */

const filtre = require('../services/leadSpamFilter');

const MARKER_KEY = 'archive-blog-spam-leads-v1';

/** Le lead est-il un robot jamais traité ? Retourne ses signaux, sinon null. */
function signauxRobotIntact(lead) {
  if (!lead || lead.captureSource !== 'blog_cta') return null;
  if (lead.archived === true) return null;
  if (lead.manualStatus) return null;
  if (Array.isArray(lead.notes) && lead.notes.length) return null;
  if (Array.isArray(lead.communications) && lead.communications.length) return null;
  if ((lead.manualEmailsSent || 0) > 0 || (lead.manualSmsSent || 0) > 0) return null;
  const r = lead.requested || {};
  const sigs = filtre.signauxBlog({ phone: lead.phone, vehicle: r.vehicle, vin: r.vin, plate: r.plate });
  return sigs.length >= 2 ? sigs : null;
}

async function archiveBlogSpamLeads(connection) {
  try {
    const db = connection && connection.db ? connection.db : null;
    if (!db) return;

    const markers = db.collection('migrationsapplied');
    const already = await markers.findOne({ key: MARKER_KEY });
    if (already) return;

    const col = db.collection('abandonedcarts');
    const candidats = await col.find(
      { captureSource: 'blog_cta', archived: { $ne: true } },
      { projection: { _id: 1, captureSource: 1, archived: 1, manualStatus: 1, notes: 1, communications: 1, manualEmailsSent: 1, manualSmsSent: 1, phone: 1, requested: 1 } }
    ).toArray();

    let ranges = 0;
    for (const lead of candidats) {
      const sigs = signauxRobotIntact(lead);
      if (!sigs) continue;
      await col.updateOne({ _id: lead._id, archived: { $ne: true } }, {
        $set: {
          archived: true,
          archivedAt: new Date(),
          archivedByName: 'Filtre anti-robots',
          archivedReason: 'spam automatique',
          spamSignals: sigs,
        },
      });
      ranges += 1;
    }

    await markers.insertOne({ key: MARKER_KEY, appliedAt: new Date(), archived: ranges, examined: candidats.length });
    console.log(`[migration] ${MARKER_KEY} : ${ranges} faux leads « Article blog » rangés sur ${candidats.length} examinés`);
  } catch (err) {
    console.error(`[migration] ${MARKER_KEY} échouée :`, err && err.message ? err.message : err);
  }
}

module.exports = { archiveBlogSpamLeads, signauxRobotIntact };
