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
  'Nos mécatroniques (calculateurs de boîte DSG / S-tronic) sont reconditionnées et testées sur banc avant expédition.',
  '',
  '**Après le montage :**',
  '- Un **codage / adaptation** par valise (VCDS, ODIS...) est nécessaire selon la référence.',
  '- Un **réglage de base** (apprentissage des points de patinage) est indispensable pour un fonctionnement optimal.',
  '',
  '**Garantie** applicable après montage et adaptations réalisés par un professionnel.',
  '',
  'Besoin d\'aide pour le codage ? Contactez-nous, nous vous guidons.',
].join('\n');

const BV_CONTENT = [
  'Nos boîtes de vitesses sont contrôlées et testées avant expédition.',
  '',
  '**Lors du montage, nous recommandons :**',
  '- le remplacement du **kit d\'embrayage** (boîtes manuelles) ;',
  '- une **vidange** avec une huile conforme aux préconisations constructeur.',
  '',
  'Le retour de votre ancienne boîte peut être demandé selon les conditions de consigne indiquées sur la fiche.',
].join('\n');

const CONSIGNE_CONTENT = [
  'La **consigne** est une caution (**hors TVA**) demandée à la commande sur certaines pièces en échange standard. Elle vous est **intégralement remboursée** au retour de votre ancienne pièce.',
  '',
  '**Comment ça marche :**',
  '- Vous recevez votre pièce reconditionnée avec un **support de transport** prévu pour le retour.',
  '- Vous renvoyez votre ancienne pièce sur ce même support, dans le délai indiqué sur la fiche.',
  '- Dès réception et vérification, la consigne est remboursée.',
  '',
  '**Bon à savoir :** l\'ancienne pièce doit être complète et non cassée. Prévenez-nous dès qu\'elle est prête pour organiser l\'enlèvement.',
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

module.exports = { seedInfoBlocks, MARKER_KEY, SEED_BLOCKS };
