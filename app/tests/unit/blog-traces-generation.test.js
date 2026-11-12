/**
 * Articles de blog gardés : les dernières traces de la chaîne de génération
 * retirées À L'AFFICHAGE (rien n'est réécrit en base).
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Audit du 25/09/2026 sur les 168 articles gardés :
 *   - un en-tête YAML affiché en tête d'article (« title: … slug: …
 *     metaTitle: … primaryKeyword: … tags: [...] ») ;
 *   - « :::product[slug] » écrit en clair dans 6 articles ;
 *   - « CPF », l'ancien sigle de la marque, dans 50 articles ;
 *   - un temps de lecture stocké et gonflé (« 7 min » pour 210 mots).
 * Le rendu réel d'un tel article est vérifié dans
 * tests/integration/pages-confiance.test.js.
 */

process.env.BRAND = 'autoliva';

const test = require('node:test');
const assert = require('node:assert');

const nettoyage = require('../../src/services/nettoyageArticle');
const blogContent = require('../../src/services/blogContent');
const { tempsDeLecture } = require('../../src/controllers/blogController')._pourTests;

/* L'en-tête tel qu'il s'affichait sur
   /blog/voiture-mode-degrade-apres-changement-mecatronique-dsg. */
const ENTETE = [
  'title: "Voiture en mode dégradé après changement de mécatronique DSG : que faire"',
  'slug: "voiture-mode-degrade-apres-changement-mecatronique-dsg"',
  'excerpt: "Votre boîte DSG est en mode dégradé après remplacement de la mécatronique ?"',
  'metaTitle: "Mode dégradé après changement mécatronique DSG : que faire"',
  'metaDescription: "Mode dégradé après remplacement de mécatronique DSG ?"',
  'primaryKeyword: "voiture en mode dégradé après changement mécatronique"',
  'cover: "/media/6a0405eb31539f66b7f6382d"',
  'publishedAt: "2026-05-13"',
  'author: "Autoliva"',
  'tags: ["DSG", "S-tronic", "mécatronique", "TCU"]',
];
const CORPS = '![Mode dégradé](/media/6a0405eb31539f66b7f6382d)\n\nVous venez de remplacer la mécatronique de votre boîte DSG.';

test('en-tête YAML : retiré du Markdown, avec ou sans filets', () => {
  for (const md of [
    ['---', ...ENTETE, '---', '', CORPS].join('\n'),
    ['', '---', ...ENTETE, '---', CORPS].join('\n'),
    [...ENTETE, '---', '', CORPS].join('\n'),
    [...ENTETE, '', CORPS].join('\n'),
    /* Liste YAML sur plusieurs lignes. */
    ['---', 'title: "Titre"', 'slug: "titre"', 'tags:', '  - DSG', '  - TCU', '---', CORPS].join('\n'),
  ]) {
    const out = nettoyage.nettoyerMarkdown(md);
    assert.ok(out.startsWith('![Mode dégradé]'), JSON.stringify(out.slice(0, 80)));
    assert.doesNotMatch(out, /primaryKeyword|metaTitle|slug:/);
  }
});

test('en-tête YAML : un article qui commence par du texte n’est jamais touché', () => {
  for (const md of [
    CORPS,
    /* Un filet suivi de texte n'est pas un en-tête. */
    '---\n\nLa boîte DSG7 est fragile.\n\n---\n\nSuite.',
    /* Typographie française : espace avant les deux-points. */
    'Description : la mécatronique pilote la boîte.\nDate : 13 mai 2026\n\nSuite.',
    /* Une seule clé connue ne suffit pas pour des lignes nues. */
    'Title: Mode dégradé\n\nSuite.',
    /* Une ligne de texte au milieu : ce n'est pas un en-tête. */
    'title: Mode dégradé\nVoici pourquoi la boîte passe en mode dégradé.\nslug: x\n\nSuite.',
  ]) {
    assert.equal(nettoyage.nettoyerMarkdown(md), md, md);
  }
});

test('en-tête YAML déjà converti en HTML : retiré en tête de corps seulement', () => {
  const html = blogContent.markdownToHtml([...ENTETE, '---', '', CORPS].join('\n'));
  assert.match(html, /^<p>title: &quot;/, 'jeu d’essai : l’en-tête est bien devenu un paragraphe');
  const out = nettoyage.nettoyerHtml(html);
  assert.ok(out.startsWith('<p><img src="/media/6a0405eb31539f66b7f6382d"'), out.slice(0, 80));
  assert.equal(nettoyage.nettoyerHtml('<hr><h2>title: Titre slug: titre</h2><hr><p>Texte.</p>'), '<p>Texte.</p>');
  for (const intact of [
    '<p>Titre : la boîte DSG. Date : mai.</p><p>Suite.</p>',
    '<p>Le titre: une mécatronique.</p>',
    '<p>Texte.</p><p>title: x slug: y</p>',
  ]) {
    assert.equal(nettoyage.nettoyerHtml(intact), intact, intact);
  }
});

test(':::product[slug] : un emplacement, rempli par la fiche ou retiré — jamais en clair', () => {
  const md = 'Intro.\n\n:::product[pont-arriere-reconditionne-mercedes-a2043500714]\n\nSuite.\n\n:::product[fiche-inconnue]\n\n:::product';
  const html = blogContent.markdownToHtml(md);
  assert.doesNotMatch(html, /:::product/);
  assert.deepEqual(blogContent.slugsEncadresProduit(html), ['pont-arriere-reconditionne-mercedes-a2043500714', 'fiche-inconnue']);

  const rempli = blogContent.remplirEncadresProduit(html, {
    nomme: (slug) => (slug === 'fiche-inconnue' ? '' : `<div class="blog-product-cta">${slug}</div>`),
    lie: () => '',
  });
  assert.match(rempli, /<div class="blog-product-cta">pont-arriere-reconditionne-mercedes-a2043500714<\/div>/);
  assert.doesNotMatch(rempli, /fiche-inconnue|data-product-slug|data-product-cta="1"><\/div>/,
    'fiche absente et aucune fiche liée : rien ne reste, pas même un cadre vide');
  assert.equal(rempli, '<p>Intro.</p>\n<div class="blog-product-cta">pont-arriere-reconditionne-mercedes-a2043500714</div>\n<p>Suite.</p>\n\n');

  /* Restée en clair dans un corps HTML (article saisi en HTML, traduction). */
  const brut = '<p>Intro.</p><p>:::product[moteur-cdi]</p><p> :::product </p>';
  const converti = blogContent.directivesProduitHtml(brut);
  assert.deepEqual(blogContent.slugsEncadresProduit(converti), ['moteur-cdi']);
  assert.equal(blogContent.remplirEncadresProduit(converti, { lie: () => 'LIE' }), '<p>Intro.</p>LIE');
  /* Le texte d'un paragraphe qui CITE la directive n'est pas touché. */
  assert.equal(blogContent.directivesProduitHtml('<p>Écrivez :::product[slug] pour…</p>'), '<p>Écrivez :::product[slug] pour…</p>');
});

test('« CPF » devient la marque, en mot entier et dans le texte seulement', () => {
  assert.equal(nettoyage.remplacerAncienSigle('Pont Reconditionné CPF, testé (CPF). Garantie « CPF » : oui.'),
    'Pont Reconditionné Autoliva, testé (Autoliva). Garantie « Autoliva » : oui.');
  assert.equal(nettoyage.remplacerAncienSigle('der CPF-Ratgeber'), 'der Autoliva-Ratgeber');
  for (const intact of ['CPF-1234', 'réf. CPF_2', '/blog/CPF/', 'CPF.fr', 'CPFX', 'ACPF', 'cpf', 'CPF2']) {
    assert.equal(nettoyage.remplacerAncienSigle(intact), intact, intact);
  }
  const html = nettoyage.nettoyerHtml('<p>Le pont CPF.</p><a href="/blog/CPF-guide" title="CPF">guide CPF</a><pre>CPF</pre><code>CPF</code>');
  assert.equal(html, '<p>Le pont Autoliva.</p><a href="/blog/CPF-guide" title="CPF">guide Autoliva</a><pre>CPF</pre><code>CPF</code>');
  assert.equal(nettoyage.nettoyerTexte('Pont CPF | CarParts France'), 'Pont Autoliva | Autoliva');
});

test('temps de lecture : recalculé sur le corps affiché, jamais lu en base', () => {
  const mots = (n) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');
  /* 210 mots, « 7 min » en base : 1 minute. */
  assert.equal(tempsDeLecture({ title: 'Test', contentMarkdown: mots(210), readingTimeMinutes: 7 }), 1);
  assert.equal(tempsDeLecture({ title: 'Test', contentHtml: `<p>${mots(1000)}</p>`, readingTimeMinutes: 2 }), 5);
  /* L'en-tête YAML et le JSON-LD collé ne se lisent pas. */
  const lourd = ['---', ...ENTETE, '---', '', mots(190), '', `<script type="application/ld+json">{"x":"${mots(600)}"}</script>`].join('\n');
  assert.equal(tempsDeLecture({ title: 'Test', contentMarkdown: lourd }), 1);
  /* Article vide : 1 minute, pas « 0 min ». */
  assert.equal(tempsDeLecture({ title: 'Vide', contentMarkdown: '' }), 1);
});
