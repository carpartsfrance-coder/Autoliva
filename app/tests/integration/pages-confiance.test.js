/**
 * Pages de confiance servies par la VRAIE application — audit qualité du
 * 25/09/2026, sur les ~2 800 pages restées indexables après la chute du 31/08.
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions
 * en mémoire), serveur sur un port éphémère.
 *
 * Les requêtes se font en PRODUCTION du point de vue des robots (NODE_ENV posé
 * après le chargement de l'application) : hors production, tout le site sort
 * « noindex, nofollow » et l'on ne verrait rien.
 *
 * Les filtres eux-mêmes sont éprouvés par les tests unitaires
 * (tests/unit/pages-confiance.test.js) ; ici, on vérifie que les pages qu'un
 * visiteur et Google reçoivent les appliquent vraiment — gabarits EJS compris.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/* Configuration AVANT tout require de l'application : brand.js et app.js lisent
   l'environnement au chargement. La production tourne sous BRAND=autoliva. */
process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
delete process.env.SCALAPAY_ENABLED;
delete process.env.SHOW_PRODUCT_DESCRIPTION;
delete process.env.SITE_URL;
delete process.env.FORCE_NOINDEX;
delete process.env.SEO_PRUNE;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let serveur;
let http;
let base;

/* Chaque lecture vient d'un visiteur Cloudflare différent : les limiteurs ne
   doivent pas se mêler des tests de contenu. */
let prochainOctet = 1;
async function get(chemin, { entetes = {} } = {}) {
  const headers = { 'User-Agent': UA_CHROME, Accept: 'text/html,application/xml', ...entetes };
  headers['CF-Connecting-IP'] = `198.51.100.${(prochainOctet++ % 250) + 1}`;
  const r = await fetch(base + chemin, { redirect: 'manual', headers });
  return { status: r.status, location: r.headers.get('location'), xRobotsTag: r.headers.get('x-robots-tag'), corps: await r.text() };
}

function decoder(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
/** Texte lisible d'une page : sans scripts, styles ni balises. */
function texte(html) {
  return decoder(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
function metaRobots(html) {
  const m = html.match(/<meta name="robots" content="([^"]*)"\/>/);
  return m ? m[1] : null;
}
function metaDescriptionBrute(html) {
  const m = html.match(/<meta name="description" content="([^"]*)"/);
  return m ? m[1] : '';
}
function locs(xml) {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(base, ''));
}

const MOTS = 'Le calculateur conserve les adaptations du véhicule donneur et la boîte passe en mode dégradé au premier démarrage ';
const ARTICLE_TRACES = {
  _id: new mongoose.Types.ObjectId(),
  title: 'Voiture en mode dégradé après changement de mécatronique : le guide CPF',
  slug: 'voiture-mode-degrade-apres-changement-mecatronique-dsg',
  excerpt: 'Mécatronique Reconditionné CPF : la cause et la solution.',
  contentMarkdown: [
    '---',
    'title: "Voiture en mode dégradé après changement de mécatronique DSG : que faire"',
    'slug: "voiture-mode-degrade-apres-changement-mecatronique-dsg"',
    'metaTitle: "Mode dégradé après changement mécatronique DSG : que faire"',
    'primaryKeyword: "voiture en mode dégradé après changement mécatronique"',
    'tags: ["DSG", "S-tronic", "mécatronique"]',
    '---',
    '',
    `Vous venez de remplacer la mécatronique. ${MOTS.repeat(10)}Solution : un clonage Reconditionné CPF.`,
    '',
    ':::product[pont-arriere-test-cta]',
    '',
    ':::product[fiche-brouillon-test]',
    '',
    ':::product[fiche-inexistante]',
    '',
    'Fin de l’article.',
  ].join('\n'),
  readingTimeMinutes: 7,
  isPublished: true,
  publishedAt: new Date('2026-05-13T10:00:00Z'),
  createdAt: new Date('2026-05-13T10:00:00Z'),
  category: { slug: 'transmission-mecatronique', label: 'Mécatronique' },
  seo: { metaTitle: '', metaDescription: '' },
  /* La traduction allemande, faite sur le HTML : la directive y est restée
     en clair, dans un paragraphe. */
  localizations: {
    de: {
      title: 'Notlauf nach Mechatronik-Tausch: der CPF-Ratgeber von CPF',
      excerpt: 'Ursache und Lösung.',
      contentHtml: '<p>Sie haben die Mechatronik getauscht.</p><p>:::product[pont-arriere-test-cta]</p><p>:::product[fiche-inexistante]</p><p>Ende.</p>',
      seo: { metaTitle: '', metaDescription: '' },
      translatedAt: new Date('2026-09-07T09:30:00Z'),
    },
  },
};

function estIndexable(r, quoi) {
  assert.equal(r.status, 200, `${quoi} : statut ${r.status} ${r.location || ''}`);
  assert.ok(!r.xRobotsTag || !/noindex/i.test(r.xRobotsTag), `${quoi} : en-tête X-Robots-Tag « ${r.xRobotsTag} »`);
  assert.match(metaRobots(r.corps) || '', /^index/, `${quoi} : balise robots « ${metaRobots(r.corps)} »`);
}
function estNoindexFollow(r, quoi) {
  assert.equal(r.status, 200, `${quoi} : statut ${r.status} — la page doit rester en ligne`);
  assert.equal(metaRobots(r.corps), 'noindex, follow', `${quoi} : balise robots`);
}

test('pages de confiance servies par l’application (audit du 25/09/2026)', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  /* Pages légales telles qu'en production : les CGV rédigées, la politique
     cookies restée au texte d'attente, une page dont le texte porte des
     apostrophes (échappées par le rendu, puis une seconde fois par le
     gabarit, jusqu'au 25/09). Les pages par défaut manquantes (CGU, mentions
     légales) sont créées au premier accès avec leur texte d'attente. */
  await db.collection('legalpages').insertMany([
    { slug: 'cgv', title: 'Conditions générales de vente', content: "Article 1 — Objet. Les présentes conditions régissent l'ensemble des ventes.", isPublished: true, sortOrder: 10 },
    { slug: 'confidentialite', title: 'Politique de confidentialité', content: "Données d'identification et d'usage : l'éditeur ne collecte que le nécessaire à la commande.", isPublished: true, sortOrder: 40 },
    { slug: 'cookies', title: 'Politique cookies', content: "À compléter dans l’admin.\n\nInformations recommandées :\n- Types de cookies\n- Durées\n- Comment gérer/retirer le consentement", isPublished: true, sortOrder: 50 },
  ]);

  /* Un article gardé tel que l'audit l'a trouvé : l'en-tête YAML de son
     fichier source en tête, « :::product[slug] » en clair (une fiche publiée,
     une en brouillon, une qui n'existe pas), « CPF » dans le titre, le résumé
     et le texte, et « 7 min » de lecture en base pour ~210 mots. */
  await db.collection('products').insertMany([
    { _id: new mongoose.Types.ObjectId(), name: 'Pont arrière reconditionné Mercedes A2043500714', slug: 'pont-arriere-test-cta', sku: 'WC-990100', category: 'Ponts & différentiels', priceCents: 129000, isPublished: true, warranty: { months: 12 }, badges: { condition: 'Reconditionné' } },
    { _id: new mongoose.Types.ObjectId(), name: 'Fiche en brouillon', slug: 'fiche-brouillon-test', sku: 'WC-990101', category: 'Ponts & différentiels', priceCents: 99000, isPublished: false },
  ]);
  await db.collection('blogposts').insertOne(ARTICLE_TRACES);

  /* Listings : deux catégories remplies, une marque et deux modèles. */
  await db.collection('categories').insertMany([
    { name: 'Boîtes de vitesses', slug: 'boites-de-vitesses', isActive: true, sortOrder: 1 },
    { name: 'Turbos', slug: 'turbos', isActive: true, sortOrder: 2 },
  ]);
  await db.collection('products').insertMany([
    { _id: new mongoose.Types.ObjectId(), name: 'Boîte de vitesses Audi A4 2.0 TDI', slug: 'boite-audi-a4-test', sku: 'WC-990110', category: 'Boîtes de vitesses', priceCents: 150000, isPublished: true, badges: { condition: 'Reconditionnée' }, compatibility: [{ make: 'Audi', model: 'A4' }] },
    { _id: new mongoose.Types.ObjectId(), name: 'Turbo Audi A4 et A6 2.0 TDI', slug: 'turbo-audi-a4-test', sku: 'WC-990111', category: 'Turbos', priceCents: 45000, isPublished: true, badges: { condition: 'Occasion' }, compatibility: [{ make: 'Audi', model: 'A4' }, { make: 'Audi', model: 'A6' }] },
  ]);

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  /* Production du point de vue des robots, pour les requêtes seulement. */
  const nodeEnvOrigine = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  t.after(async () => {
    process.env.NODE_ENV = nodeEnvOrigine;
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  await t.test('/legal/cookies au texte d’attente : en ligne, hors de Google et du sitemap', async () => {
    const r = await get('/legal/cookies');
    estNoindexFollow(r, '/legal/cookies');
    estIndexable(await get('/legal/cgv'), '/legal/cgv (rédigée)');
    estIndexable(await get('/legal/confidentialite'), '/legal/confidentialite (rédigée)');
    /* Même règle pour les pages par défaut créées au premier accès. */
    estNoindexFollow(await get('/legal/mentions-legales'), '/legal/mentions-legales (texte d’attente)');
  });

  await t.test('/legal/cgv-sav provisoire : en ligne, hors de Google, garantie légale de 2 ans pour toute pièce', async () => {
    const r = await get('/legal/cgv-sav');
    estNoindexFollow(r, '/legal/cgv-sav');
    const lisible = texte(r.corps);
    assert.ok(!/1 an\b/.test(lisible), '« 1 an » de garantie légale pour une pièce reconditionnée');
    assert.ok(lisible.includes('La garantie légale de conformité est de 2 ans à compter de la livraison, que la pièce soit neuve, reconditionnée ou d\'occasion'),
      'la phrase corrigée doit être là');
  });

  await t.test('description d’une page légale : plus de reste d’entité (« d&amp;#39; »)', async () => {
    const r = await get('/legal/confidentialite');
    const brute = metaDescriptionBrute(r.corps);
    assert.ok(!/&amp;#|&amp;amp;/.test(brute), `description doublement échappée : ${brute}`);
    assert.ok(decoder(brute).startsWith("Données d'identification et d'usage : l'éditeur"), decoder(brute));
  });

  await t.test('sitemap-pages.xml : /securite y entre, les pages provisoires en sortent', async () => {
    require('../../src/controllers/seoController').__test.viderCaches();
    const r = await get('/sitemap-pages.xml');
    assert.equal(r.status, 200);
    const pages = locs(r.corps);
    for (const attendu of ['/securite', '/legal/cgv', '/legal/confidentialite', '/faq', '/legal']) {
      assert.ok(pages.includes(attendu), `${attendu} manque au sitemap`);
    }
    for (const provisoire of ['/legal/cookies', '/legal/cgu', '/legal/mentions-legales', '/legal/cgv-sav']) {
      assert.ok(!pages.includes(provisoire), `${provisoire} (provisoire, en noindex) figure au sitemap`);
    }
    estIndexable(await get('/securite'), '/securite');
  });

  await t.test('/sav/notre-engagement : ni cases vides, ni photos « à venir » — de vrais chiffres dès qu’il y en a', async () => {
    const vide = await get('/sav/notre-engagement');
    assert.equal(vide.status, 200);
    const lisibleVide = texte(vide.corps);
    assert.ok(!/Photos atelier à venir|emplacements réservés/.test(lisibleVide), 'emplacements de photos réservés');
    assert.ok(!/—\s*%|— dossiers|délai moyen d'analyse/.test(lisibleVide), 'compteur vide ou délai écrit en dur');
    assert.ok(!lisibleVide.includes('Nos chiffres en temps réel'), 'aucun chiffre mesuré : la section doit disparaître');
    assert.ok(lisibleVide.includes('Notre atelier et notre banc DQ200'), 'le texte de l’atelier reste');

    /* Trois analyses conclues (un défaut produit), un dossier en cours. */
    await db.collection('savtickets').insertMany([
      { numero: 'SAV-T-1', statut: 'en_analyse' },
      { numero: 'SAV-T-2', statut: 'clos', analyse: { conclusion: 'defaut_produit' } },
      { numero: 'SAV-T-3', statut: 'clos', analyse: { conclusion: 'mauvais_montage' } },
      { numero: 'SAV-T-4', statut: 'clos', analyse: { conclusion: 'non_defectueux' } },
    ]);
    try {
      const lisible = texte((await get('/sav/notre-engagement')).corps);
      assert.ok(lisible.includes('Nos chiffres en temps réel'), 'la section revient avec de vrais chiffres');
      assert.ok(lisible.includes('33 % de défauts produits confirmés'), lisible.slice(lisible.indexOf('Nos chiffres'), lisible.indexOf('Nos chiffres') + 160));
      assert.ok(lisible.includes('1 dossier en cours'), 'dossiers en cours');
      assert.ok(!/—\s*%|délai moyen d'analyse/.test(lisible));
    } finally {
      await db.collection('savtickets').deleteMany({ numero: /^SAV-T-/ });
    }
  });

  await t.test('article gardé : ni en-tête YAML, ni « :::product » en clair, ni « CPF » ; temps de lecture recalculé', async () => {
    const r = await get(`/blog/${ARTICLE_TRACES.slug}`);
    assert.equal(r.status, 200, `${r.status} ${r.location || ''}`);
    const lisible = texte(r.corps);
    assert.ok(!/primaryKeyword|metaTitle|slug:|tags:/.test(lisible), 'en-tête YAML affiché');
    assert.ok(lisible.includes('Vous venez de remplacer la mécatronique.'), 'le texte de l’article doit rester');
    assert.ok(!r.corps.includes(':::product'), 'directive en clair');
    /* La fiche publiée a son encadré ; le brouillon et la fiche inconnue ne
       laissent rien — ni lien, ni cadre vide. */
    assert.match(r.corps, /<div class="blog-product-cta" data-product-cta="1"><span class="cta-eyebrow">Reconditionné — Garantie 12 mois<\/span><h3 class="cta-title">Pont arrière reconditionné Mercedes A2043500714<\/h3>/);
    assert.ok(r.corps.includes('href="/product/pont-arriere-test-cta/"'), 'lien vers la fiche nommée');
    assert.ok(!/fiche-brouillon-test|fiche-inexistante|data-product-slug/.test(r.corps), 'emplacement resté pour une fiche absente');
    assert.ok(!/<div class="blog-product-cta" data-product-cta="1"><\/div>/.test(r.corps), 'cadre vide');
    /* « CPF » : ni dans le texte, ni dans le <title>, ni dans la description, ni dans le JSON-LD. */
    assert.ok(!/\bCPF\b/.test(lisible), 'CPF dans le texte visible');
    assert.ok(!/\bCPF\b/.test(r.corps.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, '')), 'CPF dans le HTML (title, meta, JSON-LD)');
    assert.ok(lisible.includes('le guide Autoliva'), 'titre : la marque à la place du sigle');
    assert.ok(lisible.includes('Solution : un clonage Reconditionné Autoliva.'), 'texte : la marque à la place du sigle');
    /* ~210 mots, « 7 min » en base. */
    assert.ok(lisible.includes('1 min de lecture'), lisible.slice(0, 400));
    assert.ok(!lisible.includes('7 min'), '« 7 min » lu en base');

    /* En allemand, même règle : l'encadré de la fiche (en allemand), rien
       pour la fiche inconnue ; le sigle quitte le titre. */
    const de = await get(`/de/blog/${ARTICLE_TRACES.slug}`);
    assert.equal(de.status, 200, `allemand : ${de.status} ${de.location || ''}`);
    assert.ok(!de.corps.includes(':::product') && !de.corps.includes('fiche-inexistante'), 'allemand : directive en clair');
    assert.ok(de.corps.includes('href="/product/pont-arriere-test-cta/"') && de.corps.includes('Zum Produkt'), 'allemand : encadré de la fiche');
    assert.ok(texte(de.corps).includes('der Autoliva-Ratgeber von Autoliva'), 'allemand : le sigle quitte le titre');

    const liste = texte((await get('/blog')).corps);
    assert.ok(liste.includes('le guide Autoliva'), 'liste du blog : titre sans le sigle');
    assert.ok(!/\bCPF\b/.test(liste), 'liste du blog : CPF');
    assert.ok(/1 min de lecture|\b1 min\b/.test(liste) && !/\b7 min\b/.test(liste), 'liste du blog : même temps de lecture que l’article');
  });

  await t.test('facettes des pages catégorie et des hubs /pieces-auto : noindex, follow — la page nue reste indexable', async () => {
    estIndexable(await get('/categorie/boites-de-vitesses'), 'catégorie nue');
    estIndexable(await get('/categorie/boites-de-vitesses?utm_source=google&gclid=abc'), 'paramètres de suivi');
    estIndexable(await get(`/categorie/boites-de-vitesses?mainCategory=${encodeURIComponent('Boîtes de vitesses')}`), 'mainCategory = la catégorie de la page');
    for (const q of ['mainCategory=Turbos', 'condition=reconditionne', 'vehicleMake=Audi', 'vehicleMake=Audi&vehicleModel=A4', 'vehicleClear=1']) {
      estNoindexFollow(await get(`/categorie/boites-de-vitesses?${q}`), `/categorie/boites-de-vitesses?${q}`);
    }
    estIndexable(await get('/pieces-auto/audi'), 'hub marque nu');
    estIndexable(await get('/pieces-auto/audi/a4'), 'hub modèle nu');
    estIndexable(await get('/pieces-auto/audi?vehicleMake=audi'), 'vehicleMake = la marque du chemin');
    for (const chemin of ['/pieces-auto/audi?mainCategory=Turbos', '/pieces-auto/audi?condition=occasion',
      '/pieces-auto/audi?vehicleModel=A6', '/pieces-auto/audi/a4?vehicleClear=1', '/pieces-auto/audi/a4?condition=reconditionne']) {
      estNoindexFollow(await get(chemin), chemin);
    }
  });

  await t.test('lien cassé de l’article DQ200 : un 301 vers le vrai article EDC DC4, avant toute autre règle', async () => {
    const alias = await get('/blog/calculateur-edc-dc4-renault-diagnostic-prix-remplacement');
    assert.equal(alias.status, 301);
    assert.equal(alias.location, '/blog/calculateur-boite-edc-dc4-renault-diagnostic-prix-remplacement');
  });
});
