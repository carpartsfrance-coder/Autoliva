/**
 * Enquête de satisfaction avant Google — parcours client complet, servi par
 * la VRAIE application.
 *
 * Ce que ces tests protègent, dans l'ordre d'importance :
 *   1. Une note basse ne doit JAMAIS renvoyer vers Google (c'est tout l'objet
 *      du dispositif) — et une note haute doit y renvoyer sans écran de plus.
 *   2. Le retour négatif doit arriver quelque part : en base ET par e-mail.
 *      Un mécontentement perdu est pire que pas d'enquête du tout.
 *   3. Le jeton d'une commande ne doit pas changer entre deux envois, sinon
 *      le lien déjà parti par SMS cesse de marcher.
 *   4. Les pages se rendent pour de vrai (ejs.compile ne lève pas les
 *      ReferenceError d'exécution).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production ; clés d'envoi vides : aucun e-mail ni SMS ne peut partir).
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY', 'JUMINGO_API_KEY']) {
  process.env[cle] = '';
}
process.env.ADMIN_EMAIL = 'admin-enquete@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-enquete';
process.env.AVIS_ALERTE_TO_EMAIL = 'alerte@example.com';
process.env.DE_AUTO_TRANSLATE = 'false';

let serveur;
let http;
let base;
let cookie = '';

async function requete(chemin, { method = 'GET', json, form, sansSession = false } = {}) {
  const headers = {};
  if (!sansSession && cookie) headers.Cookie = cookie;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; headers.Accept = 'application/json'; body = JSON.stringify(json); }
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const r = await fetch(base + chemin, { method, headers, body, redirect: 'manual' });
  const type = r.headers.get('content-type') || '';
  const corps = type.includes('application/json') ? await r.json() : await r.text();
  return { status: r.status, corps, entetes: r.headers };
}

test('enquête de satisfaction avant Google', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const Order = require('../../src/models/Order');
  const User = require('../../src/models/User');
  const ReviewFeedback = require('../../src/models/ReviewFeedback');
  const avis = require('../../src/services/avisGoogle');

  const client = await User.create({
    email: 'client-enquete@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Julien', lastName: 'Farge', accountType: 'particulier', smsOptIn: true,
  });

  let numero = 700;
  async function commande() {
    const doc = new Order({
      userId: client._id,
      number: `CPENQ-${numero++}`,
      items: [{ name: 'Mécatronique DQ200', sku: '0AM325065S', unitPriceCents: 89000, quantity: 1, lineTotalCents: 89000 }],
      accountType: 'particulier', status: 'delivered',
      shippingAddress: { fullName: 'Julien Farge', line1: '1 rue du Test', postalCode: '06000', city: 'Nice', phone: '06 12 34 56 78' },
      billingAddress: { fullName: 'Julien Farge', line1: '1 rue du Test', postalCode: '06000', city: 'Nice' },
      subtotalCents: 89000, totalCents: 89000,
    });
    await doc.save();
    return String(doc._id);
  }
  const idContent = await commande();
  const idMecontent = await commande();

  // Espion e-mail : on compte ce qui PARTIRAIT, sans rien envoyer.
  const emailService = require('../../src/services/emailService');
  const envoyes = [];
  const vraiEmail = emailService.sendEmail;
  emailService.sendEmail = async (a) => { envoyes.push(a); return { ok: true }; };
  t.after(() => { emailService.sendEmail = vraiEmail; });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  await t.test('connexion admin', async () => {
    const r = await fetch(`${base}/admin/connexion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, returnTo: '/admin' }).toString(),
      redirect: 'manual',
    });
    assert.equal(r.status, 302);
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie);
  });

  let tokenContent = '';
  let tokenMecontent = '';

  await t.test("le message envoyé pointe sur l'enquête, pas sur Google", async () => {
    const r = await requete(`/admin/commandes/${idContent}/avis`);
    assert.equal(r.status, 200);
    for (const canal of ['email', 'sms', 'whatsapp']) {
      const corps = r.corps.canaux[canal].corps;
      assert.match(corps, /\/mon-avis\//, canal + ' doit porter le lien d\'enquête');
      assert.ok(!corps.includes(avis.LIEN_PAR_DEFAUT), canal + ' ne doit pas porter le lien Google direct');
    }
    const suivi = await ReviewFeedback.findOne({ orderId: idContent });
    assert.ok(suivi, 'le suivi doit être créé à la préparation du message');
    assert.equal(suivi.statut, 'en_attente');
    tokenContent = suivi.token;
  });

  await t.test('le jeton ne change pas entre deux préparations', async () => {
    const r = await requete(`/admin/commandes/${idContent}/avis`);
    assert.ok(r.corps.canaux.sms.corps.includes(tokenContent),
      'un second jeton invaliderait le lien déjà parti par SMS');
    assert.equal(await ReviewFeedback.countDocuments({ orderId: idContent }), 1);
  });

  await t.test("la page d'enquête s'ouvre, en noindex", async () => {
    const r = await requete(`/mon-avis/${tokenContent}`, { sansSession: true });
    assert.equal(r.status, 200);
    assert.match(r.corps, /noindex/);
    assert.match(r.corps, /CPENQ-700/);
    assert.match(r.corps, /name="note" value="5"/);
    assert.ok(!/ReferenceError/.test(r.corps));
  });

  await t.test('note 5 → redirection vers Google, sans écran de plus', async () => {
    const r = await requete(`/mon-avis/${tokenContent}`, { method: 'POST', form: { note: '5' }, sansSession: true });
    assert.equal(r.status, 302);
    assert.equal(r.entetes.get('location'), avis.LIEN_PAR_DEFAUT);
    const suivi = await ReviewFeedback.findOne({ orderId: idContent });
    assert.equal(suivi.rating, 5);
    assert.equal(suivi.statut, 'publie');
    assert.ok(suivi.redirigeGoogleAt);
  });

  await t.test('note 2 → aucune trace de Google, et une alerte interne part', async () => {
    const prep = await requete(`/admin/commandes/${idMecontent}/avis`);
    tokenMecontent = (await ReviewFeedback.findOne({ orderId: idMecontent })).token;
    assert.ok(prep.corps.canaux.email.corps.includes(tokenMecontent));

    envoyes.length = 0;
    const r = await requete(`/mon-avis/${tokenMecontent}`, { method: 'POST', form: { note: '2' }, sansSession: true });
    assert.equal(r.status, 200, 'pas de redirection : on garde le client chez nous');
    assert.match(r.corps, /Qu'est-ce qui n'a pas été/);
    assert.ok(!r.corps.includes(avis.LIEN_PAR_DEFAUT),
      'le lien Google ne doit apparaître nulle part sur la page d\'un mécontent');

    const suivi = await ReviewFeedback.findOne({ orderId: idMecontent });
    assert.equal(suivi.rating, 2);
    assert.equal(suivi.statut, 'a_traiter');
    assert.equal(suivi.redirigeGoogleAt, null);

    /* Alerte dès la note, avant tout message : beaucoup de clients s'arrêtent
       là, et un 2/5 muet est déjà une information du jour même. */
    assert.equal(envoyes.length, 1, 'une alerte interne doit partir dès la note');
    assert.equal(envoyes[0].toEmail, 'alerte@example.com');
    assert.match(envoyes[0].subject, /2\/5/);
  });

  await t.test('le message du client est enregistré et ré-alerte', async () => {
    envoyes.length = 0;
    const r = await requete(`/mon-avis/${tokenMecontent}/message`, {
      method: 'POST', sansSession: true,
      form: { message: 'La mécatronique a un code défaut au montage.', telephone: '07 88 77 66 55' },
    });
    assert.equal(r.status, 200);
    assert.match(r.corps, /Merci Julien/);

    const suivi = await ReviewFeedback.findOne({ orderId: idMecontent });
    assert.match(suivi.message, /code défaut au montage/);
    assert.equal(suivi.rappelTelephone, '07 88 77 66 55');
    assert.equal(envoyes.length, 1);
    assert.match(envoyes[0].html, /code défaut au montage/, "l'alerte doit porter le texte du client");
  });

  await t.test('un message vide est refusé plutôt qu\'enregistré à blanc', async () => {
    const r = await requete(`/mon-avis/${tokenMecontent}/message`, { method: 'POST', form: { message: '   ' }, sansSession: true });
    assert.equal(r.status, 400);
    assert.match(r.corps, /deux mots/);
  });

  await t.test('un jeton inconnu donne une page lisible, pas une 500', async () => {
    const r = await requete('/mon-avis/jeton-qui-nexiste-pas', { sansSession: true });
    assert.equal(r.status, 404);
    assert.match(r.corps, /plus valable/);
  });

  await t.test('les retours remontent dans le back-office', async () => {
    const r = await requete('/admin/avis');
    assert.equal(r.status, 200);
    assert.match(r.corps, /Retours clients/);
    assert.match(r.corps, /code défaut au montage/);
    assert.match(r.corps, /2\/5/);
    assert.ok(!/ReferenceError/.test(r.corps));
  });

  await t.test('marquer un retour résolu', async () => {
    const suivi = await ReviewFeedback.findOne({ orderId: idMecontent });
    const r = await requete(`/admin/avis/${suivi._id}/traiter`, {
      method: 'POST', form: { resolu: 'true', note: 'Rappelé, pièce remplacée', filtre: 'a_traiter' },
    });
    assert.equal(r.status, 302);
    const apres = await ReviewFeedback.findById(suivi._id);
    assert.equal(apres.statut, 'resolu');
    assert.match(apres.traitement.note, /pièce remplacée/);
    assert.ok(apres.traitement.par, "le traitement doit porter le nom de qui l'a fait");
  });

  await t.test('rouvrir la page après une note basse ne reperd pas le retour', async () => {
    const r = await requete(`/mon-avis/${tokenMecontent}`, { sansSession: true });
    assert.equal(r.status, 200);
    const apres = await ReviewFeedback.findOne({ orderId: idMecontent });
    assert.equal(apres.statut, 'resolu', 'un retour traité ne doit pas retomber en « à traiter »');
  });

  await t.test('réglage « proposer quand même Google » : le lien réapparaît', async () => {
    const idTiers = await commande();
    await requete(`/admin/commandes/${idTiers}/avis`);
    const token = (await ReviewFeedback.findOne({ orderId: idTiers })).token;

    const enregistre = await requete('/admin/parametres/avis', {
      method: 'POST',
      form: {
        lienAvis: '', enabled_email: 'on', enabled_sms: 'on', enabled_whatsapp: 'on',
        corps_email: avis.DEFAUTS.email.corps, sujet_email: avis.DEFAUTS.email.sujet,
        corps_sms: avis.DEFAUTS.sms.corps, corps_whatsapp: avis.DEFAUTS.whatsapp.corps,
        enquete_active: 'on', enquete_seuil: '4', enquete_proposerGoogle: 'on',
      },
    });
    assert.equal(enregistre.status, 302);

    const r = await requete(`/mon-avis/${token}`, { method: 'POST', form: { note: '1' }, sansSession: true });
    assert.equal(r.status, 200, 'on garde la demande d\'explication');
    assert.ok(r.corps.includes(avis.LIEN_PAR_DEFAUT), 'mais le lien Google doit être proposé');
  });

  await t.test('enquête coupée : on revient au lien Google direct', async () => {
    const enregistre = await requete('/admin/parametres/avis', {
      method: 'POST',
      form: {
        lienAvis: '', enabled_email: 'on', enabled_sms: 'on', enabled_whatsapp: 'on',
        corps_email: avis.DEFAUTS.email.corps, sujet_email: avis.DEFAUTS.email.sujet,
        corps_sms: avis.DEFAUTS.sms.corps, corps_whatsapp: avis.DEFAUTS.whatsapp.corps,
        enquete_seuil: '4', // enquete_active décoché
      },
    });
    assert.equal(enregistre.status, 302);

    const idSansEnquete = await commande();
    const prep = await requete(`/admin/commandes/${idSansEnquete}/avis`);
    assert.ok(prep.corps.canaux.sms.corps.includes(avis.LIEN_PAR_DEFAUT),
      'sans enquête, le message doit porter le lien Google — jamais un message sans lien');
    assert.equal(await ReviewFeedback.countDocuments({ orderId: idSansEnquete }), 0,
      'pas de jeton créé pour rien quand l\'enquête est coupée');

    /* Les liens DÉJÀ partis ne doivent pas tomber sur une page morte. */
    const r = await requete(`/mon-avis/${tokenContent}`, { sansSession: true });
    assert.equal(r.status, 302);
    assert.equal(r.entetes.get('location'), avis.LIEN_PAR_DEFAUT);
  });
});
