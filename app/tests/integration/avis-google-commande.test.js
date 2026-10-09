/**
 * Demande d'avis Google — servie par la VRAIE application, derrière la vraie
 * connexion admin.
 *
 * Pourquoi en intégration et pas seulement en unitaire : les deux pannes
 * qu'on veut exclure ne sont pas dans la logique mais dans le câblage.
 *   1. La page de réglages est une vue EJS — une variable oubliée ne se voit
 *      qu'au rendu réel (ejs.compile ne lève pas les ReferenceError d'exécution).
 *   2. Les routes du composeur sont imbriquées sous /commandes/:orderId, où un
 *      ordre de déclaration malheureux ferait répondre une autre route.
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
process.env.ADMIN_EMAIL = 'admin-avis@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-avis';
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

test("demande d'avis Google sur une commande", async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const Order = require('../../src/models/Order');
  const User = require('../../src/models/User');
  const avis = require('../../src/services/avisGoogle');

  const client = await User.create({
    email: 'client-avis@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Julien', lastName: 'Farge', accountType: 'particulier', smsOptIn: true,
  });

  let numero = 500;
  async function commande(over) {
    const doc = new Order({
      userId: client._id,
      number: `CPAVIS-${numero++}`,
      items: [{ name: 'Mécatronique DQ200', sku: '0AM325065S', unitPriceCents: 89000, quantity: 1, lineTotalCents: 89000 }],
      accountType: 'particulier',
      shippingAddress: { fullName: 'Julien Farge', line1: '1 rue du Test', postalCode: '06000', city: 'Nice', phone: '06 12 34 56 78' },
      billingAddress: { fullName: 'Julien Farge', line1: '1 rue du Test', postalCode: '06000', city: 'Nice' },
      subtotalCents: 89000, totalCents: 89000,
      ...over,
    });
    await doc.save();
    return String(doc._id);
  }

  const idLivree = await commande({ status: 'delivered' });
  const idAnnulee = await commande({ status: 'cancelled' });
  const idSansTel = await commande({
    status: 'delivered',
    shippingAddress: { fullName: 'Sans Tel', line1: '2 rue du Test', postalCode: '06000', city: 'Nice' },
    billingAddress: { fullName: 'Sans Tel', line1: '2 rue du Test', postalCode: '06000', city: 'Nice' },
  });

  /* Espions : on compte ce qui PARTIRAIT, sans rien envoyer. Les clés d'API
     sont vides de toute façon — l'espion sert à obtenir un succès et donc à
     vérifier la trace posée sur la commande. */
  const emailService = require('../../src/services/emailService');
  const smsService = require('../../src/services/smsService');
  const envoyes = [];
  const vraiEmail = emailService.sendEmail;
  const vraiSms = smsService.sendSms;
  emailService.sendEmail = async (a) => { envoyes.push({ canal: 'email', ...a }); return { ok: true }; };
  smsService.sendSms = async (a) => { envoyes.push({ canal: 'sms', ...a }); return { ok: true }; };
  t.after(() => { emailService.sendEmail = vraiEmail; smsService.sendSms = vraiSms; });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  await t.test('sans session : tout est refusé', async () => {
    const r = await requete(`/admin/commandes/${idLivree}/avis`, { sansSession: true });
    assert.ok(r.status === 302 || r.status === 401 || r.status === 403, 'statut inattendu : ' + r.status);
    const p = await requete('/admin/parametres/avis', { sansSession: true });
    assert.ok(p.status === 302 || p.status === 401 || p.status === 403, 'statut inattendu : ' + p.status);
  });

  await t.test('connexion admin', async () => {
    const r = await fetch(`${base}/admin/connexion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, returnTo: '/admin' }).toString(),
      redirect: 'manual',
    });
    assert.equal(r.status, 302, 'la connexion doit rediriger');
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, 'cookie de session attendu');
  });

  await t.test('la page de réglages se rend vraiment', async () => {
    const r = await requete('/admin/parametres/avis');
    assert.equal(r.status, 200);
    assert.match(r.corps, /Demande d'avis Google/);
    // Les trois canaux et le lien par défaut sont bien dans le HTML.
    assert.match(r.corps, /name="corps_email"/);
    assert.match(r.corps, /name="corps_sms"/);
    assert.match(r.corps, /name="corps_whatsapp"/);
    assert.ok(r.corps.includes(avis.LIEN_PAR_DEFAUT), 'le lien par défaut doit être affiché');
    assert.ok(!/ReferenceError/.test(r.corps));
  });

  await t.test('le détail de la commande porte le composeur', async () => {
    const r = await requete(`/admin/commandes/${idLivree}`);
    assert.equal(r.status, 200);
    assert.match(r.corps, /id="reviewRequestBtn"/);
    assert.match(r.corps, /id="avisModal"/);
    assert.match(r.corps, /data-avis-envoyer="whatsapp"/);
    // Le bouton ne doit plus parler d'Avis Vérifiés.
    assert.ok(!/Skeepers|Avis V[eé]rifi[eé]s/.test(r.corps));
  });

  await t.test('un dossier SAV en cours est signalé sur la commande et dans le composeur', async () => {
    const SavTicket = require('../../src/models/SavTicket');
    const o = await Order.findById(idLivree).lean();

    const ticket = await SavTicket.create({
      numero: 'SAV-TEST-0001',
      numeroCommande: o.number,
      statut: 'en_analyse',
      pieceType: 'mecatronique',
      client: { nom: 'Julien Farge', email: 'client-avis@example.com' },
    });
    /* Pas de t.after ici : il s'exécuterait APRÈS la déconnexion mongoose du
       test parent. La base en mémoire est jetée à la fin, il n'y a rien à
       nettoyer. */

    // Sur la fiche commande : bandeau rouge et lien vers le dossier.
    const fiche = await requete(`/admin/commandes/${idLivree}`);
    assert.equal(fiche.status, 200);
    assert.match(fiche.corps, /data-sav-bandeau="ouvert"/);
    assert.match(fiche.corps, /SAV-TEST-0001/);
    assert.match(fiche.corps, /En analyse/);
    assert.match(fiche.corps, /\/admin\/sav\/tickets\/SAV-TEST-0001/);

    // Dans le composeur : l'avertissement remonte en JSON.
    const comp = await requete(`/admin/commandes/${idLivree}/avis`);
    assert.equal(comp.corps.savOuvert.numero, 'SAV-TEST-0001');
    assert.equal(comp.corps.savOuvert.statut, 'En analyse');

    /* Un dossier CLOS ne doit pas déclencher l'avertissement : sinon il
       hurlerait sur toutes les commandes ayant un historique SAV. */
    await SavTicket.updateOne({ _id: ticket._id }, { $set: { statut: 'resolu_garantie' } });
    const apres = await requete(`/admin/commandes/${idLivree}/avis`);
    assert.equal(apres.corps.savOuvert, null);
    const fiche2 = await requete(`/admin/commandes/${idLivree}`);
    assert.ok(!/data-sav-bandeau="ouvert"/.test(fiche2.corps), 'un dossier clos ne doit pas alerter');
    assert.match(fiche2.corps, /data-sav-bandeau="clos"/, "l'historique reste visible, en gris");
  });

  await t.test('une commande sans SAV n\'affiche aucun bandeau', async () => {
    const fiche = await requete(`/admin/commandes/${idSansTel}`);
    assert.equal(fiche.status, 200);
    /* Sur `data-sav-bandeau` et non sur le texte : la chaîne « Dossier SAV
       en cours » existe aussi dans le JS du composeur, présent sur toutes
       les fiches. */
    assert.ok(!/data-sav-bandeau=/.test(fiche.corps));
  });

  await t.test('la page Paramètres mène à la nouvelle page', async () => {
    const r = await requete('/admin/parametres');
    assert.equal(r.status, 200);
    assert.match(r.corps, /\/admin\/parametres\/avis/);
  });

  await t.test('les anciennes routes Skeepers ont disparu', async () => {
    const a = await requete(`/admin/commandes/${idLivree}/demande-avis`, { method: 'POST', json: {} });
    assert.equal(a.status, 404);
    const b = await requete('/admin/api/reviews/diagnostic');
    assert.equal(b.status, 404);
  });

  await t.test('composeur : les trois messages arrivent préremplis', async () => {
    const r = await requete(`/admin/commandes/${idLivree}/avis`);
    assert.equal(r.status, 200);
    assert.equal(r.corps.ok, true);
    assert.equal(r.corps.canaux.email.destinataire, 'client-avis@example.com');
    assert.equal(r.corps.canaux.sms.destinataire, '+33612345678');
    for (const canal of ['email', 'sms', 'whatsapp']) {
      const c = r.corps.canaux[canal];
      assert.equal(c.enabled, true, canal);
      /* Le lien envoyé est celui de l'enquête, pas Google : c'est elle qui
         décide ensuite où va le client (cf. avis-enquete.test.js). */
      assert.match(c.corps, /\/mon-avis\//, canal + ' doit porter le lien');
      assert.ok(!/\{\w+\}/.test(c.corps), canal + ' : variable non substituée → ' + c.corps);
      /* Chaque message doit permettre au client de RECONNAÎTRE son achat.
         L'e-mail et WhatsApp ont la place pour le n° de commande ; le SMS
         nomme la pièce — « #CPAVIS-500 » n'évoque rien pour le client, et
         160 caractères ne permettent pas les deux. */
      if (canal === 'sms') {
        assert.match(c.corps, /mécatronique DQ200/i, 'le SMS doit nommer la pièce');
      } else {
        assert.ok(c.corps.includes('CPAVIS-500'), canal + ' doit porter le n° de commande');
      }
    }
    assert.equal(r.corps.deja.at, null);
  });

  await t.test('une commande annulée est refusée', async () => {
    const r = await requete(`/admin/commandes/${idAnnulee}/avis`);
    assert.equal(r.status, 400);
    assert.match(r.corps.error, /cancelled/);
    const e = await requete(`/admin/commandes/${idAnnulee}/avis/email`, { method: 'POST', json: { corps: 'Coucou' } });
    assert.equal(e.status, 400, "l'envoi doit être refusé lui aussi, pas seulement le préremplissage");
  });

  await t.test("l'e-mail part avec le texte modifié par l'admin", async () => {
    envoyes.length = 0;
    const r = await requete(`/admin/commandes/${idLivree}/avis/email`, {
      method: 'POST',
      json: { sujet: 'Un avis ?', corps: 'Bonjour Julien,\n\n' + avis.LIEN_PAR_DEFAUT + '\n\nMerci' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.corps.ok, true);
    assert.equal(envoyes.length, 1);
    assert.equal(envoyes[0].toEmail, 'client-avis@example.com');
    assert.equal(envoyes[0].subject, 'Un avis ?');
    assert.match(envoyes[0].html, /Laisser un avis sur Google/);

    const o = await Order.findById(idLivree).lean();
    assert.ok(o.notifications.googleReviewRequestedAt, 'la demande doit être tracée');
    assert.deepEqual(o.notifications.googleReviewChannels, ['email']);
    assert.ok((o.emailsSent || []).some((e) => e.type === 'avis_google' && e.status === 'sent'));
  });

  await t.test('le SMS part et prévient du risque de filtrage du lien', async () => {
    envoyes.length = 0;
    const r = await requete(`/admin/commandes/${idLivree}/avis/sms`, { method: 'POST', json: { corps: 'Avis ? ' + avis.LIEN_PAR_DEFAUT } });
    assert.equal(r.status, 200);
    assert.equal(envoyes.length, 1);
    assert.equal(envoyes[0].to, '+33612345678');
    assert.match(r.corps.avertissement, /opérateurs/);

    const o = await Order.findById(idLivree).lean();
    assert.deepEqual(o.notifications.googleReviewChannels.sort(), ['email', 'sms']);
    assert.ok((o.smsSent || []).some((s) => s.type === 'avis_google'));
  });

  await t.test('WhatsApp renvoie un lien wa.me prérempli, sans rien envoyer', async () => {
    envoyes.length = 0;
    const r = await requete(`/admin/commandes/${idLivree}/avis/whatsapp`, { method: 'POST', json: { corps: 'Bonjour ! ' + avis.LIEN_PAR_DEFAUT } });
    assert.equal(r.status, 200);
    assert.equal(envoyes.length, 0, 'WhatsApp part du téléphone du commercial : rien ne doit être envoyé côté serveur');
    assert.match(r.corps.waUrl, /^https:\/\/wa\.me\/33612345678\?text=/);
    assert.ok(decodeURIComponent(r.corps.waUrl.split('text=')[1]).includes(avis.LIEN_PAR_DEFAUT));
  });

  await t.test('sans téléphone : SMS et WhatsApp refusés, e-mail toujours possible', async () => {
    const s = await requete(`/admin/commandes/${idSansTel}/avis/sms`, { method: 'POST', json: { corps: 'Avis ?' } });
    assert.equal(s.status, 400);
    assert.match(s.corps.error, /numéro/);
    const w = await requete(`/admin/commandes/${idSansTel}/avis/whatsapp`, { method: 'POST', json: { corps: 'Avis ?' } });
    assert.equal(w.status, 400);
    const e = await requete(`/admin/commandes/${idSansTel}/avis/email`, { method: 'POST', json: { corps: 'Avis ? ' + avis.LIEN_PAR_DEFAUT } });
    assert.equal(e.status, 200);
  });

  await t.test('un canal désactivé dans les réglages refuse l\'envoi', async () => {
    const enregistre = await requete('/admin/parametres/avis', {
      method: 'POST',
      form: {
        lienAvis: 'https://search.google.com/local/writereview?placeid=TEST',
        enabled_email: 'on', // sms et whatsapp décochés
        corps_email: 'Bonjour {prenom}, {lienAvis}',
        sujet_email: 'Avis {orderNumber}',
        corps_sms: avis.DEFAUTS.sms.corps,
        corps_whatsapp: avis.DEFAUTS.whatsapp.corps,
      },
    });
    assert.equal(enregistre.status, 302);
    assert.match(enregistre.entetes.get('location'), /saved=1/);

    const s = await requete(`/admin/commandes/${idLivree}/avis/sms`, { method: 'POST', json: { corps: 'Avis ?' } });
    assert.equal(s.status, 400);
    assert.match(s.corps.error, /désactivé/);

    /* Le nouveau lien et le nouveau texte sont bien ceux proposés ensuite. */
    const p = await requete(`/admin/commandes/${idLivree}/avis`);
    assert.equal(p.corps.lienAvis, 'https://search.google.com/local/writereview?placeid=TEST');
    assert.equal(p.corps.canaux.email.corps, 'Bonjour Julien, https://search.google.com/local/writereview?placeid=TEST');
    assert.equal(p.corps.canaux.email.sujet, 'Avis CPAVIS-500');
    assert.equal(p.corps.canaux.sms.enabled, false);
  });

  await t.test('un lien invalide est refusé et ne casse pas le réglage', async () => {
    const r = await requete('/admin/parametres/avis', {
      method: 'POST',
      form: { lienAvis: 'pas-une-url', enabled_email: 'on' },
    });
    assert.equal(r.status, 302);
    assert.match(r.entetes.get('location'), /erreur=/);
    assert.equal(await avis.getLien(), 'https://search.google.com/local/writereview?placeid=TEST');
  });
});
