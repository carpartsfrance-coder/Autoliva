/**
 * Photos d'une fiche dans l'admin (PR #323, corrigée le 12/11/2026).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, photos
 * stockées dans le GridFS de la base en mémoire).
 *
 * Avant : ajouter une photo la mettait en principale ET effaçait l'ancienne
 * principale du stockage. Ce test passe par le vrai contrôleur
 * (postAdminUpdateProduct) :
 *   - ajout sans ordre envoyé (JavaScript coupé) : la principale reste, la
 *     photo ajoutée va en fin de galerie, rien n'est effacé ;
 *   - ordre envoyé par l'écran photos (mediaOrder) : une photo ajoutée peut
 *     devenir la principale, l'ancienne passe dans la galerie ;
 *   - une photo retirée de l'ordre est effacée du stockage, les autres non ;
 *   - une photo encore utilisée par une autre fiche n'est jamais effacée
 *     (modification, suppression d'une fiche, suppression groupée).
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY']) process.env[cle] = '';

/* PNG 1×1 valide : pas besoin d'une bibliothèque d'images. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

test('admin : photos d’une fiche — ajout, ordre, suppression, sans perte', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;
  t.after(async () => { await mongoose.disconnect(); await serveur.stop(); });

  const mediaStorage = require('../../src/services/mediaStorage');
  const admin = require('../../src/controllers/adminController');

  const enregistrer = (nom) => mediaStorage.saveBuffer({ buffer: PNG, filename: `${nom}.png`, mimeType: 'image/png', optimiser: false });
  const existe = async (url) => {
    const id = String(url || '').replace('/media/', '');
    return mongoose.Types.ObjectId.isValid(id) && !!(await db.collection('media.files').findOne({ _id: new mongoose.Types.ObjectId(id) }));
  };
  const fichier = (nom) => ({ fieldname: 'image', originalname: `${nom}.png`, mimetype: 'image/png', buffer: PNG, size: PNG.length });

  const p1 = (await enregistrer('p1')).url;
  const p2 = (await enregistrer('p2')).url;
  const p3 = (await enregistrer('p3')).url;
  const produitId = new mongoose.Types.ObjectId();
  await db.collection('products').insertOne({
    _id: produitId, name: 'Pont arrière essai photos', slug: 'pont-arriere-essai-photos', sku: 'ESSAI-PHOTOS',
    category: 'Autre', priceCents: 100000, isPublished: false, imageUrl: p1, galleryUrls: [p2, p3], galleryTypes: ['image', 'image'],
  });

  /* Le formulaire tel que l'écran l'envoie (champs obligatoires remplis). */
  const corps = (extra) => ({
    name: 'Pont arrière essai photos', slug: 'pont-arriere-essai-photos', sku: 'ESSAI-PHOTOS', category: 'Autre',
    price: '1000,00', isPublished: 'false', specType: 'Pont arrière', badgeTopLeft: 'Garantie 12 mois', badgeCondition: 'Reconditionné',
    shortDescription: 'Résumé', description: 'Description', removeMainImage: 'false', ...extra,
  });
  const envoyer = async (body, files = []) => {
    const res = { code: 200, redirection: null, vue: null, options: null };
    res.status = (c) => { res.code = c; return res; };
    res.redirect = (a, b) => { res.redirection = b || a; return res; };
    res.render = (vue, options) => { res.vue = vue; res.options = options; return res; };
    res.json = () => res;
    const req = { params: { productId: String(produitId) }, body, files, session: { admin: { adminUserId: null, role: 'owner' } }, headers: {}, query: {} };
    await admin.postAdminUpdateProduct(req, res, (e) => { throw e; });
    assert.equal(res.vue, null, `formulaire refusé : ${res.options && res.options.errorMessage}`);
    return db.collection('products').findOne({ _id: produitId });
  };

  await t.test('ajout sans ordre envoyé : la principale reste, rien n’est effacé', async () => {
    const f = await envoyer(corps({ imageUrl: p1, galleryUrls: [p2, p3].join('\n'), galleryTypes: 'image\nimage' }), [fichier('nouvelle')]);
    assert.equal(f.imageUrl, p1, 'la principale ne change pas');
    assert.deepEqual(f.galleryUrls.slice(0, 2), [p2, p3]);
    assert.equal(f.galleryUrls.length, 3, 'la photo ajoutée est en fin de galerie');
    for (const u of [p1, p2, p3]) assert.ok(await existe(u), `${u} toujours dans le stockage`);
  });

  await t.test('ordre envoyé : une photo ajoutée peut devenir la principale', async () => {
    const avant = await db.collection('products').findOne({ _id: produitId });
    const ordre = [{ i: 0, t: 'image' }, { u: avant.imageUrl, t: 'image' }, ...avant.galleryUrls.map((u) => ({ u, t: 'image' }))];
    const f = await envoyer(corps({ mediaOrder: JSON.stringify(ordre), imageUrl: '', galleryUrls: [avant.imageUrl, ...avant.galleryUrls].join('\n') }), [fichier('principale')]);
    assert.ok(![p1, p2, p3, ...avant.galleryUrls].includes(f.imageUrl), 'la nouvelle photo est la principale');
    assert.deepEqual(f.galleryUrls, [avant.imageUrl, ...avant.galleryUrls], 'les autres suivent, dans l’ordre');
    for (const u of [p1, p2, p3]) assert.ok(await existe(u), `${u} toujours dans le stockage`);
  });

  await t.test('photo retirée de l’ordre : effacée du stockage, les autres gardées', async () => {
    const avant = await db.collection('products').findOne({ _id: produitId });
    const gardees = [avant.imageUrl, ...avant.galleryUrls].filter((u) => u !== p2);
    const f = await envoyer(corps({ mediaOrder: JSON.stringify(gardees.map((u) => ({ u, t: 'image' }))), imageUrl: gardees[0], galleryUrls: gardees.slice(1).join('\n') }));
    assert.ok(![f.imageUrl, ...f.galleryUrls].includes(p2));
    assert.equal(await existe(p2), false, 'p2 effacée du stockage');
    for (const u of gardees) assert.ok(await existe(u), `${u} gardée`);
  });

  /* Deux fiches peuvent partager le même fichier (« Dupliquer » copie les
     adresses, l'import JSON réutilise une photo déjà téléchargée). */
  const copieId = new mongoose.Types.ObjectId();
  const autreId = new mongoose.Types.ObjectId();

  await t.test('photo retirée d’une fiche mais utilisée par une autre : jamais effacée', async () => {
    const avant = await db.collection('products').findOne({ _id: produitId });
    const ajoutee = avant.galleryUrls[avant.galleryUrls.length - 1];
    await db.collection('products').insertOne({
      _id: copieId, name: 'Pont arrière essai photos (copie)', slug: 'pont-arriere-essai-photos-copie', sku: 'ESSAI-PHOTOS-COPIE',
      category: 'Autre', priceCents: 100000, isPublished: false, imageUrl: p1, galleryUrls: [p3, ajoutee], galleryTypes: ['image', 'image'],
    });
    const gardees = [avant.imageUrl, ajoutee];
    const f = await envoyer(corps({ mediaOrder: JSON.stringify(gardees.map((u) => ({ u, t: 'image' }))), imageUrl: gardees[0], galleryUrls: gardees.slice(1).join('\n') }));
    assert.deepEqual([f.imageUrl, ...f.galleryUrls], gardees);
    assert.ok(await existe(p1), 'p1 gardée : la copie l’utilise');
    assert.ok(await existe(p3), 'p3 gardée : la copie l’utilise');
  });

  await t.test('fiche supprimée : ses photos partagées restent pour l’autre fiche', async () => {
    const avant = await db.collection('products').findOne({ _id: produitId });
    const res = { redirect: () => res, status: () => res, render: () => res, json: () => res };
    await admin.postAdminDeleteProduct({ params: { productId: String(produitId) }, body: {}, session: {}, headers: {} }, res, (e) => { throw e; });
    assert.equal(await db.collection('products').findOne({ _id: produitId }), null, 'fiche supprimée');
    assert.equal(await existe(avant.imageUrl), false, 'sa photo à elle seule : effacée');
    assert.ok(await existe(avant.galleryUrls[0]), 'la photo partagée avec la copie : gardée');
  });

  await t.test('suppression groupée : seules les photos sans autre fiche sont effacées', async () => {
    const copie = await db.collection('products').findOne({ _id: copieId });
    await db.collection('products').insertOne({
      _id: autreId, name: 'Autre fiche', slug: 'autre-fiche-essai', sku: 'ESSAI-AUTRE',
      category: 'Autre', priceCents: 100000, isPublished: false, imageUrl: p3, galleryUrls: [], galleryTypes: [],
    });
    const res = { redirect: () => res, status: () => res, render: () => res, json: () => res };
    await admin.postAdminBulkDeleteProducts({ body: { productIds: [String(copieId)] }, session: {}, headers: {} }, res, (e) => { throw e; });
    assert.equal(await db.collection('products').findOne({ _id: copieId }), null, 'copie supprimée');
    assert.equal(await existe(copie.imageUrl), false, 'p1 effacée : plus aucune fiche ne l’utilise');
    assert.equal(await existe(copie.galleryUrls[1]), false, 'la photo ajoutée : effacée');
    assert.ok(await existe(p3), 'p3 gardée : « Autre fiche » l’utilise');
  });
});
