/**
 * Relecture humaine incomplète dans l'admin blog : le formulaire revient avec
 * un message ET la saisie — en création comme en modification.
 *
 * Lancé par : npm test
 *
 * Base : mongodb-memory-server, créée et détruite par ce fichier. TEST_MONGODB_URI
 * permet de viser une base de test explicite ; MONGODB_URI est volontairement
 * IGNORÉE — c'est la variable de l'application, et dans ce dépôt elle désigne
 * la base de PRODUCTION.
 *
 * d19f75d renvoyait, en modification, une redirection vers la fiche : l'article
 * était relu depuis la base et tout ce qui venait d'être tapé était perdu.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ejs = require('ejs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const BlogPost = require('../../src/models/BlogPost');
const blogAdmin = require('../../src/controllers/blogAdminController');

let memoire;

test.before(async () => {
  const uri = process.env.TEST_MONGODB_URI || (memoire = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await BlogPost.deleteMany({ slug: /^test-relecture-/ });
    await mongoose.disconnect();
  }
  if (memoire) await memoire.stop();
});

/* Réponse Express réduite à ce que le contrôleur utilise. */
function reponse() {
  const r = { code: 200, vue: null, locals: null, redirection: null };
  r.status = (c) => { r.code = c; return r; };
  r.render = (vue, locals) => { r.vue = vue; r.locals = locals; };
  r.redirect = (url) => { r.redirection = url; };
  return r;
}

test('modification : la relecture sans date revient avec le message et le texte modifié', async () => {
  const post = await BlogPost.create({
    title: 'Titre en base',
    slug: 'test-relecture-modif',
    contentMarkdown: 'Texte en base.',
    isPublished: false,
  });
  const req = {
    params: { postId: String(post._id) },
    session: {},
    body: {
      title: 'Titre modifié',
      slug: 'test-relecture-modif',
      contentMarkdown: 'Texte modifié, long travail.',
      reviewedBy: 'Killian',
      reviewerRole: 'gérant',
      reviewedAt: '',
    },
  };
  const res = reponse();
  await blogAdmin.postAdminUpdateBlogPost(req, res, (err) => { throw err; });

  assert.equal(res.redirection, null, 'pas de redirection : elle effaçait la saisie');
  assert.equal(res.code, 400);
  assert.equal(res.vue, 'admin/blog-post');
  assert.match(res.locals.errorMessage, /nom de la personne ET une date/);
  assert.equal(res.locals.form.contentMarkdown, 'Texte modifié, long travail.');
  assert.equal(res.locals.form.title, 'Titre modifié');
  assert.equal(res.locals.form.reviewedBy, 'Killian');

  /* Rien n'est écrit. */
  const enBase = await BlogPost.findById(post._id).lean();
  assert.equal(enBase.title, 'Titre en base');
  assert.equal(enBase.contentMarkdown, 'Texte en base.');
  assert.ok(!enBase.reviewedBy);

  /* La vue se rend réellement avec ces données (mode édition), plus les
     variables que l'application pose sur toutes les pages. */
  const html = await ejs.renderFile(path.join(__dirname, '../../src/views/admin/blog-post.ejs'), {
    ...res.locals,
    brand: require('../../src/config/brand'),
    currentPath: `/admin/blog/${post._id}`,
    currentAdmin: { email: 'admin@example.com' },
    assetVersions: { mainCss: 1, adminCss: 1 },
    polices: require('../../src/services/policesLocales').charger(),
  });
  assert.match(html, /Texte modifié, long travail\./);
  assert.match(html, /nom de la personne ET une date/);
  assert.match(html, new RegExp(`action="/admin/blog/${post._id}"`));
});

test('création : même règle, rien n’est créé', async () => {
  const req = {
    params: {},
    session: {},
    body: { title: 'Nouvel article', slug: 'test-relecture-creation', contentMarkdown: 'Brouillon.', reviewedBy: '', reviewedAt: '2026-09-14', reviewerRole: '' },
  };
  const res = reponse();
  await blogAdmin.postAdminCreateBlogPost(req, res, (err) => { throw err; });
  assert.equal(res.code, 400);
  assert.equal(res.locals.form.reviewedAt, '2026-09-14', 'la saisie reste affichée');
  assert.equal(await BlogPost.countDocuments({ slug: 'test-relecture-creation' }), 0);
});
