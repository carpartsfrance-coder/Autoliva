'use strict';

/**
 * Migration ONE-SHOT : remplace le contenu « placeholder » des blocs seedés
 * (mécatroniques, boîtes, consigne) par le vrai contenu — car le texte
 * « (Bloc de départ — à compléter...) » était visible côté client.
 *
 * - Ne met à jour un bloc QUE si son contenu contient encore le marqueur
 *   « à compléter » → préserve toute édition déjà faite dans l'admin.
 * - Garde-fou par marqueur : ne s'exécute qu'une fois.
 * - Non bloquante.
 */

const { SEED_BLOCKS } = require('./seedInfoBlocks');

const MARKER_KEY = 'update-info-blocks-content-v1';
const PLACEHOLDER_NEEDLE = 'à compléter';

async function updateInfoBlocksContent(connection) {
  try {
    const db = connection && connection.db ? connection.db : null;
    if (!db) return;

    const markers = db.collection('migrationsapplied');
    const already = await markers.findOne({ key: MARKER_KEY });
    if (already) return;

    const col = db.collection('infoblocks');
    let updated = 0;
    for (const b of SEED_BLOCKS) {
      const res = await col.updateOne(
        { slug: b.slug, content: { $regex: PLACEHOLDER_NEEDLE, $options: 'i' } },
        { $set: { content: b.content, updatedAt: new Date() } }
      );
      const n = (res && (res.modifiedCount != null ? res.modifiedCount : res.nModified)) || 0;
      updated += n;
    }

    await markers.insertOne({ key: MARKER_KEY, appliedAt: new Date(), updated });
    console.log(`[migration ${MARKER_KEY}] Contenu des blocs mis à jour : ${updated}.`);
  } catch (err) {
    console.error('[migration update-info-blocks-content] échec (non bloquant) :', err && err.message ? err.message : err);
  }
}

module.exports = { updateInfoBlocksContent, MARKER_KEY };
