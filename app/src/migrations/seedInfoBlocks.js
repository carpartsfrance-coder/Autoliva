'use strict';

/**
 * Migration ONE-SHOT : crée les 4 blocs d'information « Conditions » de départ.
 *
 * - Garde-fou par marqueur : ne s'exécute qu'UNE fois (ne recrée pas un bloc
 *   supprimé ensuite, n'écrase jamais une édition admin).
 * - upsert $setOnInsert par slug : si un bloc du même slug existe déjà, il est
 *   laissé intact.
 * - Non bloquante : toute erreur est loggée mais n'empêche pas le démarrage.
 *
 * Appelée au démarrage (server.js) après la connexion MongoDB.
 */

const MARKER_KEY = 'seed-info-blocks-v1';

const MOTEURS_CONTENT = [
  'Nos moteurs reconditionnés sont livrés **nus** (sans système d\'injection ni turbo).',
  '',
  '**Composants remis à neuf :**',
  '- Bloc réalésé ou rechemisé',
  '- Culasse éprouvée',
  '- Pistons et segmentation neufs',
  '- Coussinets neufs',
  '- Jeu de joints neuf',
  '',
  'Chaque moteur est contrôlé avant expédition : **test de pression d\'huile** et **mesure des compressions**.',
  '',
  '**Garantie : 1 an pièces et main d\'œuvre.**',
  '',
  '**Avant le montage :**',
  '- L\'habillage du moteur est variable selon l\'origine : à vérifier avant le montage.',
  '- La récupération du couvre-culasse et/ou du carter de votre ancien moteur est parfois nécessaire.',
  '- Les injecteurs et le turbo sont disponibles **en option, sur demande**.',
  '',
  '**Pour valider la garantie :** effectuez le **rodage** puis une **vidange à 1 000 km**.',
  '',
  '**Retour de l\'ancienne pièce obligatoire** sur le support de transport fourni. Merci de nous informer de sa disponibilité pour organiser l\'enlèvement.',
].join('\n');

const MECA_CONTENT = [
  '- La mécatronique est livrée **vierge** ou pré-codée selon la référence : un **codage / adaptation** par valise (VCDS, ODIS...) est requis après montage.',
  '- Un **réglage de base** (apprentissage des points de patinage) est indispensable pour un fonctionnement optimal.',
  '- Garantie applicable après montage par un professionnel et réalisation des adaptations.',
  '',
  '*(Bloc de départ — à compléter selon vos conditions.)*',
].join('\n');

const BV_CONTENT = [
  '- Boîte contrôlée et testée avant expédition.',
  '- Remplacement du **kit d\'embrayage** et de l\'**huile de boîte** conseillé lors du montage.',
  '- Retour de l\'ancienne pièce selon les conditions de consigne.',
  '',
  '*(Bloc de départ — à compléter selon vos conditions.)*',
].join('\n');

const CONSIGNE_CONTENT = [
  '- Une **consigne** (caution **hors TVA**) peut s\'appliquer ; elle est remboursée au retour de votre ancienne pièce.',
  '- Le retour s\'effectue sur le **support de transport fourni**, dans le délai indiqué.',
  '- Prévenez-nous de la disponibilité de la pièce pour organiser l\'enlèvement.',
  '',
  '*(Bloc de départ — à compléter selon vos conditions.)*',
].join('\n');

const SEED_BLOCKS = [
  {
    slug: 'conditions-moteurs-reconditionnes',
    title: 'Conditions — Moteurs reconditionnés',
    content: MOTEURS_CONTENT,
    position: 'after_inclusions',
    autoCategories: ['moteur'],
    sortOrder: 1,
  },
  {
    slug: 'conditions-mecatroniques',
    title: 'Conditions — Mécatroniques (programmation, réglage de base)',
    content: MECA_CONTENT,
    position: 'after_inclusions',
    autoCategories: ['mécatron', 'mecatron', 'tcu'],
    sortOrder: 2,
  },
  {
    slug: 'conditions-boites-de-vitesses',
    title: 'Conditions — Boîtes de vitesses',
    content: BV_CONTENT,
    position: 'after_inclusions',
    autoCategories: ['boîte de vitesses', 'boite de vitesses'],
    sortOrder: 3,
  },
  {
    slug: 'conditions-consigne-retour',
    title: 'Conditions — Consigne & retour',
    content: CONSIGNE_CONTENT,
    position: 'after_inclusions',
    autoCategories: [],
    sortOrder: 4,
  },
];

async function seedInfoBlocks(connection) {
  try {
    const db = connection && connection.db ? connection.db : null;
    if (!db) return;

    const markers = db.collection('migrationsapplied');
    const already = await markers.findOne({ key: MARKER_KEY });
    if (already) return;

    const col = db.collection('infoblocks');
    let inserted = 0;
    for (const b of SEED_BLOCKS) {
      const res = await col.updateOne(
        { slug: b.slug },
        {
          $setOnInsert: {
            slug: b.slug,
            title: b.title,
            content: b.content,
            position: b.position,
            autoCategories: b.autoCategories,
            isActive: true,
            sortOrder: b.sortOrder,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
      if (res && (res.upsertedCount || (res.upsertedId ? 1 : 0))) inserted += 1;
    }

    await markers.insertOne({ key: MARKER_KEY, appliedAt: new Date(), inserted });
    console.log(`[migration ${MARKER_KEY}] Blocs d'information : ${inserted} créé(s).`);
  } catch (err) {
    console.error('[migration seed-info-blocks] échec (non bloquant) :', err && err.message ? err.message : err);
  }
}

module.exports = { seedInfoBlocks, MARKER_KEY };
