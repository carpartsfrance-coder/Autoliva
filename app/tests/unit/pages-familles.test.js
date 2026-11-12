/**
 * Contenu des pages familles — audit SEO du 11/11/2026, problèmes 4 et 8.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Le texte vit dans src/data/seo/pages-familles.json : ce test est sa
 * relecture automatique avant la mise en ligne — longueurs (title ≤ 60,
 * description ≤ 160), et aucune allégation que le site s'interdit ailleurs
 * (src/data/seo/claims-policy.json, services/claimFilter.js).
 */

const test = require('node:test');
const assert = require('node:assert');

const { familles } = require('../../src/data/seo/pages-familles.json');
const pagesFamilles = require('../../src/services/pagesFamilles');
const { ajusterTitre } = require('../../src/services/titreSeo');

const INTERDIT = [
  [/ISO\s?-?\s?9001/i, 'ISO 9001 (non prouvé)'],
  [/\bnotre atelier\b|\bnos ateliers\b/i, 'atelier propre (reconditionné chez un partenaire)'],
  [/\b(?:2|deux)\s+ans\b|\b24\s+mois\b|\b12\s+mois\b/i, 'durée de garantie générale (elle dépend de la fiche)'],
  [/sans frais|\b[34]x\b|\ben [34] fois\b|scalapay/i, 'paiement en plusieurs fois (coupé)'],
  [/\bconcessionnaires?\b/i, 'équipe les concessionnaires (non prouvé)'],
  [/\b24\s?h\b|\b48\s?h\b|\bsous\s+\d+\s+jours?\b/i, 'délai promis (il est sur la fiche)'],
];

function texteDe(famille) {
  return [famille.titre, famille.description, famille.h1, famille.introHtml,
    ...(famille.faq || []).flatMap((q) => [q.question, q.reponse]),
    ...(famille.liens || []).map((l) => l.texte)].join(' \n ');
}

test('les trois familles prioritaires sont là', () => {
  assert.deepEqual(Object.keys(familles).sort(), ['boites-de-transfert', 'mecatroniques', 'ponts-differentiels']);
});

test('longueurs : title ≤ 60 et servi tel quel, description 120–160, intro 80–250 mots', () => {
  for (const [slug, f] of Object.entries(familles)) {
    assert.ok(f.titre.length <= 60, `${slug} : title de ${f.titre.length} caractères`);
    const { texte, suffixe } = require('../../src/services/titreSeo').separerSuffixe(f.titre, 'Autoliva');
    assert.equal(ajusterTitre(texte, { suffixe, modeSuffixe: 'prefere' }), f.titre, `${slug} : le title serait réécrit`);
    assert.ok(f.description.length >= 120 && f.description.length <= 160, `${slug} : description de ${f.description.length} caractères`);
    const mots = f.introHtml.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    assert.ok(mots >= 80 && mots <= 250, `${slug} : intro de ${mots} mots`);
    assert.ok(f.h1 && f.h1.length <= 70, `${slug} : H1`);
    assert.ok(Array.isArray(f.faq) && f.faq.length >= 3, `${slug} : FAQ`);
  }
});

test('aucune allégation que le site s’interdit', () => {
  for (const [slug, f] of Object.entries(familles)) {
    const txt = texteDe(f);
    for (const [motif, pourquoi] of INTERDIT) {
      assert.doesNotMatch(txt, motif, `${slug} : ${pourquoi}`);
    }
  }
});

test('le title de catégorie ne copie pas celui de la page de devis', () => {
  assert.doesNotMatch(familles['ponts-differentiels'].titre, /échange standard garanti/i);
  assert.doesNotMatch(familles['boites-de-transfert'].titre, /échange standard garanti/i);
});

test('liens internes : chemins du site, le premier mène à un devis', () => {
  for (const [slug, f] of Object.entries(familles)) {
    assert.ok(f.liens.length >= 1, slug);
    for (const l of f.liens) assert.match(l.href, /^\/[a-z0-9/-]+$/, `${slug} : ${l.href}`);
    assert.match(f.liens[0].href, /^\/(ponts-differentiels|boites-de-transfert|devis)$/, `${slug} : premier lien`);
  }
});

test('FAQPage : une question par entrée, réponses en texte brut', () => {
  const faq = pagesFamilles.faqJsonLd(pagesFamilles.pourCategorie('mecatroniques'));
  assert.equal(faq['@type'], 'FAQPage');
  assert.equal(faq.mainEntity.length, familles.mecatroniques.faq.length);
  for (const q of faq.mainEntity) assert.doesNotMatch(q.acceptedAnswer.text, /<[^>]+>/);
});

test('français seulement', () => {
  assert.ok(pagesFamilles.pourCategorie('ponts-differentiels', 'fr'));
  assert.equal(pagesFamilles.pourCategorie('ponts-differentiels', 'de'), null);
  assert.equal(pagesFamilles.pourCategorie('turbos', 'fr'), null);
});

test('problème 8 : chaque article d’une famille prioritaire reçoit le lien de sa catégorie', () => {
  const L = (categorie, titre) => (pagesFamilles.lienFamillePourArticle({ categorie, titre }) || {}).href || null;
  assert.equal(L('transmission-pont-differentiel', 'Bruit de pont avant BMW X1'), '/categorie/ponts-differentiels');
  assert.equal(L('transmission-boite-transfert', ''), '/categorie/boites-de-transfert');
  assert.equal(L('transmission-mecatronique', ''), '/categorie/mecatroniques');
  /* Catégorie absente ou générale : le titre décide, transfert avant pont. */
  assert.equal(L('', 'Boîte de transfert BMW X1 F48 xDrive : symptômes de la PTO'), '/categorie/boites-de-transfert');
  assert.equal(L('transmission-boite-de-vitesses', 'Mécatronique DSG7 DQ381 : diagnostic, prix'), '/categorie/mecatroniques');
  assert.equal(L('', 'Différentiel arrière Toyota Hilux : bruit et remplacement'), '/categorie/ponts-differentiels');
  assert.equal(L('moteur-diesel', 'Moteur 2.0 TDI : casse de bielle'), null);
});
