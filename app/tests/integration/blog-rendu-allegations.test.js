/**
 * Une page d'article, telle que les contrôleurs la rendent, ne montre plus
 * les restes de la chaîne ni les promesses non prouvées — dans le corps, le
 * résumé ET la description Google, en français et en allemand.
 *
 * Lancé par : npm test
 *
 * Base : mongodb-memory-server, créée et détruite par ce fichier. MONGODB_URI
 * est volontairement IGNORÉE : dans ce dépôt elle désigne la PRODUCTION.
 *
 * Les tests unitaires couvrent les filtres ; celui-ci vérifie que les deux
 * contrôleurs les APPELLENT, au bon endroit (la relecture du 15/09 a relevé
 * qu'aucun test ne le prouvait, et que le résumé échappait au filtre).
 */

process.env.BRAND = 'autoliva';
delete process.env.SCALAPAY_ENABLED;
delete process.env.SEO_PRUNE;

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const BlogPost = require('../../src/models/BlogPost');
const blogController = require('../../src/controllers/blogController');
const blogDeController = require('../../src/controllers/blogDeController');

let memoire;
const SLUG = 'test-rendu-allegations';

test.before(async () => {
  const uri = process.env.TEST_MONGODB_URI || (memoire = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
  await BlogPost.create({
    title: 'Pont arrière BMW : diagnostic et prix',
    slug: SLUG,
    isPublished: true,
    publishedAt: new Date('2026-05-10T10:00:00Z'),
    authorName: 'Expert CarParts',
    excerpt: 'Pont reconditionné chez CarPartsFrance, payable en 3 x 263 EUR sans frais.',
    seo: { metaDescription: 'Pont arrière BMW reconditionné : prix, garantie et paiement en 3 fois sans frais.' },
    contentMarkdown: [
      'Le pont arrière est un organe robuste.',
      '',
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage"}</script>',
      '',
      'Le pont reconditionné est à 1 890 € TTC, payable en 3 x 630 EUR sans frais.',
      '',
      'Les roulements de porte-satellites sont contrôlés.',
      '',
      '## Articles liés du cocon BMW',
      '',
      '- [Voir le guide](https://car-parts-france-fr-refonte.onrender.com/blog/autre-guide)',
      '',
      'Commandé chez Car Parts France.',
    ].join('\n'),
    localizations: {
      de: {
        translatedAt: new Date('2026-09-08T10:00:00Z'),
        title: 'BMW Hinterachsdifferential: Diagnose und Preis',
        excerpt: 'Generalüberholtes Differential, Ratenzahlung möglich.',
        seo: { metaDescription: 'BMW Differential generalüberholt: Preis und Ratenzahlung ohne Aufpreis.' },
        contentHtml: '<p>Das Differential ist robust.</p><p>Zahlung in 3 Raten ohne Aufpreis möglich.</p>'
          + '<p>Die Satellitenräder werden geprüft.</p><h2>Themen-Cluster</h2><p>Bei CarPartsFrance bestellt.</p>',
      },
    },
  });
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await BlogPost.deleteMany({ slug: SLUG });
    await mongoose.disconnect();
  }
  if (memoire) await memoire.stop();
});

function fausseReq(lang) {
  const chemin = lang === 'de' ? `/de/blog/${SLUG}` : `/blog/${SLUG}`;
  return {
    params: { slug: SLUG }, query: {}, lang, path: chemin, originalUrl: chemin,
    protocol: 'https', hostname: 'autoliva.com', headers: { host: 'autoliva.com' },
    get: (h) => (String(h).toLowerCase() === 'host' ? 'autoliva.com' : undefined),
  };
}

function fausseRes() {
  const res = { code: 200, vue: null, rendu: null, locals: {}, entetes: {} };
  res.status = (c) => { res.code = c; return res; };
  res.set = (k, v) => { res.entetes[k] = v; return res; };
  res.render = (vue, locals) => { res.vue = vue; res.rendu = locals; return res; };
  res.redirect = (a, b) => { res.redirection = b || a; return res; };
  return res;
}

const PROMESSE = /[34]\s?[x×]\s*\d|en [34] fois|Raten|Ratenzahlung/i;

test('article français : corps, résumé, description et signature', async () => {
  const res = fausseRes();
  await blogController.getBlogPost(fausseReq('fr'), res, (e) => { throw e; });
  assert.equal(res.vue, 'blog/show', `rendu inattendu (${res.code} ${res.vue})`);
  const { post } = res.rendu;
  assert.doesNotMatch(post.contentHtml, PROMESSE, 'promesse de paiement dans le corps');
  assert.doesNotMatch(post.contentHtml, /@context|ld\+json|cocon|onrender|car ?parts ?france/i);
  assert.match(post.contentHtml, /porte-satellites/, 'une vraie pièce a été retirée');
  assert.match(post.contentHtml, /href="\/blog\/autre-guide"/, 'le lien de préproduction doit pointer sur le site');
  assert.doesNotMatch(post.excerpt || '', PROMESSE, 'promesse dans le résumé');
  assert.doesNotMatch(post.excerpt || '', /car ?parts ?france/i, 'ancien nom dans le résumé');
  assert.doesNotMatch(res.rendu.metaDescription || '', PROMESSE, 'promesse dans la description Google');
  assert.equal(post.authorName, 'l\'équipe Autoliva');
  const brut = res.rendu.jsonLd;
  const ld = typeof brut === 'string' ? JSON.parse(brut) : brut;
  const article = (ld['@graph'] || [ld]).find((n) => n['@type'] === 'BlogPosting');
  assert.equal(article.author['@type'], 'Organization', 'l’auteur doit être l’organisation');
  assert.doesNotMatch(article.description || '', PROMESSE, 'promesse dans la description du JSON-LD');
});

test('article allemand : mêmes règles', async () => {
  const res = fausseRes();
  await blogDeController.getBlogPostDe(fausseReq('de'), res, (e) => { throw e; });
  assert.equal(res.vue, 'blog/show', `rendu inattendu (${res.code} ${res.vue})`);
  const { post } = res.rendu;
  assert.doesNotMatch(post.contentHtml, PROMESSE, 'promesse de paiement dans le corps allemand');
  assert.doesNotMatch(post.contentHtml, /Themen-Cluster|car ?parts ?france/i);
  assert.match(post.contentHtml, /Satellitenräder/, 'une vraie pièce a été retirée');
  assert.doesNotMatch(post.excerpt || '', PROMESSE, 'promesse dans le résumé allemand');
  assert.doesNotMatch(res.rendu.metaDescription || '', PROMESSE, 'promesse dans la description Google allemande');
  assert.equal(post.authorName, 'der Autoliva-Redaktion');
});
