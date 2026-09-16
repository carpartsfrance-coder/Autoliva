/**
 * Liste des commandes en files de traitement — servie par la VRAIE application,
 * derrière la vraie connexion admin.
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
delete process.env.SCALAPAY_ENABLED;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY', 'SKEEPERS_API_KEY', 'JUMINGO_API_KEY']) {
  process.env[cle] = '';
}
process.env.ADMIN_EMAIL = 'admin-test@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-files';
process.env.DE_AUTO_TRANSLATE = 'false';

const JOUR = 24 * 3600 * 1000;
const ilYa = (jours) => new Date(Date.now() - jours * JOUR - 3600 * 1000);

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
  const corps = type.includes('application/json') ? await r.json() : (type.includes('application/pdf') ? Buffer.from(await r.arrayBuffer()) : await r.text());
  return { status: r.status, corps, entetes: r.headers };
}

/* Compteur d'une file dans le HTML : <a … data-file="x" …> … data-file-total>N< */
function compteur(html, file) {
  const m = html.match(new RegExp(`data-file="${file}"[\\s\\S]*?data-file-total>(\\d+)<`));
  return m ? Number(m[1]) : null;
}
function lignes(html) {
  return [...html.matchAll(/class="cmd-ligne[^"]*"[^>]*data-id="([a-f0-9]{24})"/g)].map((m) => m[1]);
}

test('liste des commandes en files de traitement', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const Order = require('../../src/models/Order');
  const User = require('../../src/models/User');

  const client = await User.create({
    email: 'client-files@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Julien', lastName: 'Farge', accountType: 'particulier',
  });

  let numero = 100;
  /* Insertion brute après validation : on peut dater la commande dans le passé. */
  async function commande(over) {
    const { createdAt, ...reste } = over;
    const doc = new Order({
      userId: client._id,
      number: `CPTEST-${numero++}`,
      items: [{ name: 'Mécatronique DQ200', sku: '0AM325065S', unitPriceCents: 89000, quantity: 1, lineTotalCents: 89000 }],
      accountType: 'particulier',
      shippingAddress: { fullName: 'Julien Farge', line1: '1 rue du Test', postalCode: '06000', city: 'Nice' },
      billingAddress: { fullName: 'Julien Farge', line1: '1 rue du Test', postalCode: '06000', city: 'Nice' },
      subtotalCents: 89000,
      totalCents: 89000,
      ...reste,
    });
    await doc.validate();
    const brut = doc.toObject();
    brut.createdAt = createdAt || ilYa(1);
    brut.updatedAt = brut.createdAt;
    await Order.collection.insertOne(brut);
    return String(brut._id);
  }

  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  const etiquettePdf = Buffer.from(await pdf.save());

  const ids = {
    aVerifier: await commande({ status: 'paid', sourcing: { status: 'a_verifier' }, statusHistory: [{ status: 'paid', changedAt: ilYa(3), changedBy: 'test' }], createdAt: ilYa(3) }),
    aCommander: await commande({ status: 'processing', sourcing: { status: 'a_commander', updatedAt: ilYa(1) } }),
    commandee: await commande({ status: 'processing', sourcing: { status: 'commandee', orderedAt: ilYa(10), expectedDays: 7 } }),
    enStock: await commande({ status: 'processing', sourcing: { status: 'en_stock' } }),
    etiquetteSansSuivi: await commande({ status: 'label_created', sourcing: { status: 'a_verifier' } }),
    etiquetteAvecSuivi: await commande({
      status: 'label_created', sourcing: { status: 'en_stock' },
      shipments: [{ label: 'Envoi', carrier: 'Jumingo', trackingNumber: 'JMG123FR', createdAt: ilYa(0), document: { originalName: 'etiquette.pdf', fileData: etiquettePdf, sizeBytes: etiquettePdf.length } }],
    }),
    expediee: await commande({ status: 'shipped', statusHistory: [{ status: 'shipped', changedAt: ilYa(8), changedBy: 'test' }], shipments: [{ label: 'Envoi', carrier: 'Jumingo', trackingNumber: 'JMG456FR', createdAt: ilYa(8) }] }),
    livreeConsigne: await commande({ status: 'delivered', orderType: 'exchange', returnStatus: 'pending', returnDates: { returnDueDate: new Date(Date.now() + 10 * JOUR) } }),
    livree: await commande({ status: 'delivered' }),
    annulee: await commande({ status: 'cancelled' }),
    payeeFiche: await commande({ status: 'paid', sourcing: { status: 'en_stock' } }),
    archivee: await commande({ status: 'paid', archived: true }),
  };

  /* Espions sur le message « commande validée » (e-mail + SMS) : on compte ce
     qui PARTIRAIT, sans rien envoyer. */
  const emailService = require('../../src/services/emailService');
  const smsService = require('../../src/services/smsService');
  const messagesValidee = [];
  const vraiEmail = emailService.sendOrderStatusChangeEmail;
  const vraiSms = smsService.sendOrderStatusChangeSms;
  emailService.sendOrderStatusChangeEmail = async (a) => { messagesValidee.push(`email:${a.order._id}`); return { ok: false, reason: 'test' }; };
  smsService.sendOrderStatusChangeSms = async (a) => { messagesValidee.push(`sms:${a.order._id}`); return { ok: false, reason: 'test' }; };
  t.after(() => { emailService.sendOrderStatusChangeEmail = vraiEmail; smsService.sendOrderStatusChangeSms = vraiSms; });

  /* Espion sur l'e-mail « date de livraison » : lent (30 ms) pour que deux
     clics rapprochés se chevauchent vraiment ; `echecLivraison` simule un
     fournisseur d'e-mails en panne. */
  const envoisLivraison = [];
  let echecLivraison = false;
  const vraiLivraison = emailService.sendDeliveryEstimateEmail;
  emailService.sendDeliveryEstimateEmail = async (a) => {
    await new Promise((r) => setTimeout(r, 30));
    const ok = !echecLivraison;
    envoisLivraison.push({ id: String(a.order._id), date: a.date, changement: a.changement, email: a.user.email, ok });
    return ok ? { ok: true } : { ok: false, reason: 'panne_test' };
  };
  t.after(() => { emailService.sendDeliveryEstimateEmail = vraiLivraison; });
  const dansJours = (n) => new Date(Date.now() + n * JOUR).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const livraisonPrevue = (id, date, options = {}) => requete(`/admin/commandes/${id}/livraison-prevue`, { method: 'POST', json: { date, file: 'commandee' }, ...options });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  await t.test('sans session : les actions sont refusées', async () => {
    const r = await requete(`/admin/commandes/${ids.aVerifier}/avancer`, { method: 'POST', json: { action: 'en_stock' }, sansSession: true });
    assert.equal(r.status, 401);
  });

  await t.test('connexion admin', async () => {
    const r = await fetch(`${base}/admin/connexion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, returnTo: '/admin/commandes' }).toString(),
      redirect: 'manual',
    });
    assert.equal(r.status, 302, 'la connexion doit rediriger');
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, 'cookie de session attendu');
  });

  await t.test('la page s’ouvre sur « Appro à vérifier », compteurs et retards justes', async () => {
    const r = await requete('/admin/commandes');
    assert.equal(r.status, 200);
    const html = r.corps;
    assert.equal(compteur(html, 'a_verifier'), 1);
    assert.equal(compteur(html, 'a_commander'), 1);
    assert.equal(compteur(html, 'commandee'), 1);
    assert.equal(compteur(html, 'expedier'), 4, 'deux en stock + deux étiquettes, dont celle sans appro renseignée');
    assert.equal(compteur(html, 'transit'), 2, 'la livrée dont la consigne n’est pas revenue n’est plus « en transit »');
    assert.equal(compteur(html, 'all'), 11, 'toutes les commandes actives, annulée comprise, archivée exclue');
    assert.deepEqual(lignes(html), [ids.aVerifier]);
    assert.match(html, /Pièce en stock \?/);
    assert.match(html, /Retard 2j/);
    assert.match(html, /4 prêtes à expédier/);
    assert.match(html, /1 pièce fournisseur en retard/);
  });

  await t.test('« À expédier » : l’étiquette sans suivi ouvre la saisie, celle avec suivi s’expédie en un clic', async () => {
    const html = (await requete('/admin/commandes?file=expedier')).corps;
    assert.deepEqual(new Set(lignes(html)), new Set([ids.enStock, ids.payeeFiche, ids.etiquetteSansSuivi, ids.etiquetteAvecSuivi]));
    const ligneSans = html.slice(html.indexOf(`data-id="${ids.etiquetteSansSuivi}"`));
    assert.match(ligneSans.slice(0, 6000), /data-ouvrir="expedition" data-message="CPTEST-\d+ — renseigne le numéro de suivi/);
    const ligneAvec = html.slice(html.indexOf(`data-id="${ids.etiquetteAvecSuivi}"`));
    assert.match(ligneAvec.slice(0, 6000), /data-action="expediee"/);
  });

  await t.test('« À recevoir » : fournisseur en retard signalé sous l’appro', async () => {
    const html = (await requete('/admin/commandes?file=commandee')).corps;
    assert.deepEqual(lignes(html), [ids.commandee]);
    assert.match(html, /Fournisseur en retard · 3j/);
  });

  await t.test('recherche : Entrée envoie le formulaire, et trouve par n° de suivi ou référence de pièce', async () => {
    const page = (await requete('/admin/commandes')).corps;
    /* Sans bouton d'envoi, un formulaire à plusieurs champs texte ne part pas
       sur Entrée : la recherche dans toutes les commandes ne marchait pas. */
    assert.match(page, /<form id="cmdRecherche"[\s\S]*?<button type="submit"[\s\S]*?<\/form>/);
    let html = (await requete('/admin/commandes?file=all&q=JMG123FR')).corps;
    assert.deepEqual(lignes(html), [ids.etiquetteAvecSuivi], 'numéro de suivi');
    html = (await requete('/admin/commandes?file=all&q=325065S')).corps;
    assert.ok(lignes(html).includes(ids.enStock), 'référence de pièce');
  });

  await t.test('un lien avec filtre (tableau de bord, favori) cherche dans « Toutes », comme avant', async () => {
    const html = (await requete('/admin/commandes?status=cancelled')).corps;
    assert.match(html, /Toutes les commandes/);
    assert.deepEqual(lignes(html), [ids.annulee]);
  });

  await t.test('avancer : « Oui, en stock » passe en préparation et fait changer de file', async () => {
    const r = await requete(`/admin/commandes/${ids.aVerifier}/avancer`, {
      method: 'POST', json: { action: 'en_stock', attendu: { status: 'paid', appro: 'a_verifier' }, file: 'a_verifier' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.ok, true);
    assert.deepEqual(r.corps.ligne.files, ['expedier', 'all']);
    assert.equal(r.corps.compteurs.a_verifier.total, 0);
    assert.equal(r.corps.compteurs.expedier.total, 5);
    assert.match(r.corps.ligne.html, /class="cmd-ligne/);
    const o = await Order.findById(ids.aVerifier).lean();
    assert.equal(o.status, 'processing');
    assert.equal(o.sourcing.status, 'en_stock');
    assert.equal(o.statusHistory[o.statusHistory.length - 1].status, 'processing', 'le changement de statut passe par l’historique');
    /* « En préparation » depuis la liste est une étape interne : pas d'e-mail
       ni de SMS « commande validée » (le client a sa confirmation au paiement). */
    assert.deepEqual(messagesValidee.filter((m) => m.endsWith(ids.aVerifier)), []);
  });

  await t.test('deux personnes sur la même commande : la seconde action est refusée (409)', async () => {
    const r = await requete(`/admin/commandes/${ids.aVerifier}/avancer`, {
      method: 'POST', json: { action: 'en_stock', attendu: { status: 'paid', appro: 'a_verifier' }, file: 'a_verifier' },
    });
    assert.equal(r.status, 409);
    assert.equal(r.corps.code, 'etat_change');
    assert.match(r.corps.ligne.html, /class="cmd-ligne/);
  });

  await t.test('« Commandée » horodate la commande fournisseur', async () => {
    const r = await requete(`/admin/commandes/${ids.aCommander}/avancer`, {
      method: 'POST', json: { action: 'commandee', attendu: { status: 'processing', appro: 'a_commander' }, file: 'a_commander' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    const o = await Order.findById(ids.aCommander).lean();
    assert.equal(o.sourcing.status, 'commandee');
    assert.ok(o.sourcing.orderedAt, 'date de commande fournisseur');
    assert.equal(o.sourcing.expectedDays, 7);
  });

  await t.test('garde-fou : pas d’« expédiée » sans numéro de suivi (422), rien n’est écrit', async () => {
    const r = await requete(`/admin/commandes/${ids.etiquetteSansSuivi}/avancer`, {
      method: 'POST', json: { action: 'expediee', attendu: { status: 'label_created', appro: 'en_stock' }, file: 'expedier' },
    });
    assert.equal(r.status, 422);
    assert.equal(r.corps.code, 'suivi_manquant');
    assert.equal((await Order.findById(ids.etiquetteSansSuivi).lean()).status, 'label_created');
  });

  await t.test('garde-fou : pas de « terminer » tant que l’ancienne pièce n’est pas revenue (422)', async () => {
    const r = await requete(`/admin/commandes/${ids.livreeConsigne}/avancer`, {
      method: 'POST', json: { action: 'terminer', attendu: { status: 'delivered', appro: 'en_stock' }, file: 'transit' },
    });
    assert.equal(r.status, 422);
    assert.equal(r.corps.code, 'retour_attendu');
    assert.equal((await Order.findById(ids.livreeConsigne).lean()).status, 'delivered');
  });

  await t.test('« Livrée » puis « Terminer » sur une vente simple', async () => {
    let r = await requete(`/admin/commandes/${ids.expediee}/avancer`, {
      method: 'POST', json: { action: 'livree', attendu: { status: 'shipped', appro: 'en_stock' }, file: 'transit' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal((await Order.findById(ids.expediee).lean()).status, 'delivered');
    r = await requete(`/admin/commandes/${ids.livree}/avancer`, {
      method: 'POST', json: { action: 'terminer', attendu: { status: 'delivered', appro: 'en_stock' }, file: 'transit' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.deepEqual(r.corps.ligne.files, ['all']);
    assert.equal((await Order.findById(ids.livree).lean()).status, 'completed');
  });

  await t.test('la fiche, elle, prévient toujours le client quand on passe une commande payée en préparation', async () => {
    const r = await requete(`/admin/commandes/${ids.payeeFiche}/statut`, { method: 'POST', json: { status: 'processing' } });
    assert.equal(r.status, 200);
    assert.ok(messagesValidee.includes(`email:${ids.payeeFiche}`), 'e-mail « commande validée » depuis la fiche');
  });

  await t.test('le formulaire de la fiche change toujours le statut (même logique partagée)', async () => {
    const r = await requete(`/admin/commandes/${ids.enStock}/statut`, { method: 'POST', json: { status: 'label_created' } });
    assert.equal(r.status, 200);
    const o = await Order.findById(ids.enStock).lean();
    assert.equal(o.status, 'label_created');
    assert.equal(o.statusHistory[o.statusHistory.length - 1].status, 'label_created');
  });

  await t.test('la ligne à jour après une saisie dans le panneau', async () => {
    const r = await requete(`/admin/commandes/${ids.commandee}/ligne?file=commandee`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.corps.ligne.files, ['commandee', 'all']);
    assert.ok(r.corps.compteurs && r.corps.compteurs.commandee.total >= 1);
  });

  await t.test('étiquettes réunies en un seul PDF', async () => {
    const r = await requete(`/admin/commandes/etiquettes.pdf?ids=${ids.etiquetteAvecSuivi},${ids.enStock}`);
    assert.equal(r.status, 200);
    const fusion = await PDFDocument.load(r.corps);
    assert.equal(fusion.getPageCount(), 1, 'la commande sans étiquette est ignorée');
    assert.ok(r.entetes.get('x-sans-etiquette'), 'et signalée');
  });

  await t.test('suppression groupée = corbeille, jamais une suppression définitive', async () => {
    const r = await requete('/admin/commandes/corbeille-multi', { method: 'POST', json: { orderIds: [ids.annulee] } });
    assert.equal(r.status, 200);
    const o = await Order.findById(ids.annulee).lean();
    assert.ok(o, 'la commande existe toujours');
    assert.ok(o.deletedAt, 'elle est dans la corbeille');
    const html = (await requete('/admin/commandes?view=trash')).corps;
    assert.deepEqual(lignes(html), [ids.annulee]);
    assert.match(html, /Restaurer/);
  });

  await t.test('livraison prévue : sans session, refusé', async () => {
    const r = await livraisonPrevue(ids.commandee, dansJours(5), { sansSession: true });
    assert.equal(r.status, 401);
    assert.equal(envoisLivraison.length, 0);
  });

  await t.test('livraison prévue : la première date part au client, une seule fois', async () => {
    const date = dansJours(5);
    let r = await livraisonPrevue(ids.commandee, date);
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.email.envoye, true);
    assert.deepEqual(envoisLivraison.map((e) => [e.id, e.date, e.changement, e.email]), [[ids.commandee, date, false, 'client-files@example.com']]);

    const o = await Order.findById(ids.commandee).lean();
    assert.equal(o.deliveryEstimate.date.toISOString().slice(0, 10), date);
    assert.equal(o.notifications.deliveryEstimateSentFor, date);
    assert.ok(o.notifications.deliveryEstimateSentAt);
    assert.ok(o.emailsSent.some((e) => e.type === 'delivery_estimate' && e.status === 'sent'), 'e-mail journalisé sur la commande');
    assert.match(r.corps.ligne.html, /Livraison prévue le/);
    assert.doesNotMatch(r.corps.ligne.html, /client pas prévenu/);
    assert.deepEqual(r.corps.ligne.files, ['commandee', 'all'], 'la date ne change pas la file');

    /* Même date enregistrée une deuxième fois : rien ne repart. */
    r = await livraisonPrevue(ids.commandee, date);
    assert.equal(r.status, 200);
    assert.equal(r.corps.email.envoye, false);
    assert.equal(r.corps.email.raison, 'meme_date');
    assert.equal(envoisLivraison.length, 1);

    const page = (await requete('/admin/commandes?file=commandee')).corps;
    assert.match(page, /Livraison prévue le/);
  });

  await t.test('livraison prévue : une date modifiée part comme « nouvelle date »', async () => {
    const date = dansJours(9);
    const r = await livraisonPrevue(ids.commandee, date);
    assert.equal(r.status, 200);
    assert.equal(r.corps.email.envoye, true);
    assert.equal(envoisLivraison.length, 2);
    assert.equal(envoisLivraison[1].date, date);
    assert.equal(envoisLivraison[1].changement, true);
    assert.equal((await Order.findById(ids.commandee).lean()).notifications.deliveryEstimateSentFor, date);
  });

  await t.test('livraison prévue : un double clic n’envoie qu’un e-mail', async () => {
    const date = dansJours(12);
    const reponses = await Promise.all([livraisonPrevue(ids.commandee, date), livraisonPrevue(ids.commandee, date)]);
    reponses.forEach((r) => assert.equal(r.status, 200));
    assert.equal(envoisLivraison.filter((e) => e.date === date).length, 1);
    assert.equal(reponses.filter((r) => r.corps.email.envoye).length, 1);
  });

  await t.test('livraison prévue : e-mail en échec → la date est gardée, mais reste à envoyer', async () => {
    const date = dansJours(15);
    echecLivraison = true;
    let r;
    try {
      r = await livraisonPrevue(ids.commandee, date);
    } finally {
      echecLivraison = false;
    }
    assert.equal(r.status, 200);
    assert.equal(r.corps.email.envoye, false);
    assert.equal(r.corps.email.raison, 'panne_test');
    let o = await Order.findById(ids.commandee).lean();
    assert.equal(o.deliveryEstimate.date.toISOString().slice(0, 10), date, 'la date est enregistrée');
    assert.equal(o.notifications.deliveryEstimateSentFor, dansJours(12), 'la dernière date ENVOYÉE ne bouge pas');
    assert.ok(o.emailsSent.some((e) => e.type === 'delivery_estimate' && e.status === 'failed'));
    assert.match(r.corps.ligne.html, /client pas prévenu/);

    /* Nouvel essai, fournisseur rétabli : l'e-mail part. */
    r = await livraisonPrevue(ids.commandee, date);
    assert.equal(r.corps.email.envoye, true);
    o = await Order.findById(ids.commandee).lean();
    assert.equal(o.notifications.deliveryEstimateSentFor, date);
    assert.doesNotMatch(r.corps.ligne.html, /client pas prévenu/);
  });

  await t.test('livraison prévue : dates refusées, rien n’est écrit', async () => {
    const avant = await Order.findById(ids.commandee).lean();
    const envois = envoisLivraison.length;
    for (const date of [dansJours(-1), '2026-02-30', 'demain', dansJours(400)]) {
      const r = await livraisonPrevue(ids.commandee, date);
      assert.equal(r.status, 400, `${date} → ${r.status}`);
    }
    const apres = await Order.findById(ids.commandee).lean();
    assert.equal(String(apres.deliveryEstimate.date), String(avant.deliveryEstimate.date));
    assert.equal(envoisLivraison.length, envois);
  });

  await t.test('livraison prévue : pas sur une commande livrée (422)', async () => {
    const r = await livraisonPrevue(ids.livreeConsigne, dansJours(3));
    assert.equal(r.status, 422);
    assert.equal((await Order.findById(ids.livreeConsigne).lean()).deliveryEstimate.date, null);
  });

  await t.test('livraison prévue : retirer la date n’écrit pas au client', async () => {
    const envois = envoisLivraison.length;
    const r = await livraisonPrevue(ids.commandee, '');
    assert.equal(r.status, 200);
    assert.equal(r.corps.email.raison, 'date_retiree');
    assert.equal(envoisLivraison.length, envois);
    assert.equal((await Order.findById(ids.commandee).lean()).deliveryEstimate.date, null);
    assert.doesNotMatch(r.corps.ligne.html, /Livraison prévue le/);
  });

  await t.test('livraison prévue : le vrai service d’envoi se branche sans erreur (clé vide = rien ne part)', async () => {
    const o = await Order.findById(ids.commandee).lean();
    const r = await vraiLivraison({ order: o, user: { _id: client._id, email: client.email, firstName: 'Julien' }, date: dansJours(5) });
    assert.deepEqual(r, { ok: false, reason: 'missing_api_key' });
  });
});
