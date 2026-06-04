'use strict';

/**
 * Migration ONE-SHOT : active vatRecoverable = true sur les pièces dont la TVA
 * est récupérable au régime normal — mécatroniques (TCU), ponts / différentiels,
 * boîtes de transfert.
 *
 * - Idempotente + garde-fou par marqueur : ne s'exécute qu'UNE seule fois, donc
 *   ne réécrase jamais un réglage manuel fait ensuite dans l'admin.
 *   (elle ne fait que PASSER à true, jamais à false.)
 * - Non bloquante : toute erreur est loggée mais n'empêche pas le démarrage.
 *
 * Appelée au démarrage (server.js) après la connexion MongoDB.
 */

const MARKER_KEY = 'vat-recoverable-parts-v1';

async function applyVatRecoverableParts(connection) {
  try {
    const db = connection && connection.db ? connection.db : null;
    if (!db) return;

    const markers = db.collection('migrationsapplied');
    const already = await markers.findOne({ key: MARKER_KEY });
    if (already) return; // déjà appliquée → on ne touche plus rien

    // Catégories ciblées (stockées en « Transmission > Mécatronique », etc.).
    // Regex tolérante aux accents ; les TCU autonomes sont attrapés par le nom.
    const query = {
      $or: [
        { category: { $regex: 'm[ée]catron|pont|diff[ée]renti|bo[iî]te de transfert', $options: 'i' } },
        { name: { $regex: '\\bTCU\\b', $options: 'i' } },
      ],
    };

    const res = await db.collection('products').updateMany(query, { $set: { vatRecoverable: true } });
    const matched = (res && (res.matchedCount != null ? res.matchedCount : res.n)) || 0;
    const modified = (res && (res.modifiedCount != null ? res.modifiedCount : res.nModified)) || 0;

    await markers.insertOne({ key: MARKER_KEY, appliedAt: new Date(), matched, modified });
    console.log(`[migration ${MARKER_KEY}] TVA récupérable activée : ${modified} produit(s) mis à jour (${matched} ciblé(s)).`);
  } catch (err) {
    console.error('[migration vat-recoverable] échec (non bloquant) :', err && err.message ? err.message : err);
  }
}

module.exports = { applyVatRecoverableParts, MARKER_KEY };
