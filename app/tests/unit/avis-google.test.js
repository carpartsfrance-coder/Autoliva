/**
 * Demande d'avis Google — contenu des messages.
 *
 * Ce qui est vérifié ici tient en une phrase : un message parti chez un
 * client doit TOUJOURS contenir un lien cliquable. Les deux façons de le
 * perdre sont une variable non substituée (le client reçoit « {lienAvis} »)
 * et un override back-office vide qui écraserait le défaut.
 *
 * Base réelle (mongodb-memory-server) : les réglages passent par Mongoose, et
 * un mock de `updateOne` court-circuiterait justement la validation qu'on veut
 * éprouver.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;

const avis = require('../../src/services/avisGoogle');
const reviewFeedback = require('../../src/services/reviewFeedback');
const brand = require('../../src/config/brand');
const { buildAvisGoogleEmail } = require('../../src/services/emailTemplates');

const commande = { number: 'CP2026-000485', shippingAddress: { fullName: 'Julien Farge' } };
const client = { email: 'julien@example.com', firstName: 'Julien', lastName: 'Farge' };

test('substitution des variables', async (t) => {
  await t.test('les variables connues sont remplacées', () => {
    const vars = avis.variablesCommande({ order: commande, user: client, lienAvis: 'https://x.test/a' });
    assert.equal(vars.prenom, 'Julien');
    assert.equal(vars.orderNumber, 'CP2026-000485');
    assert.equal(vars.lienAvis, 'https://x.test/a');
    assert.equal(avis.appliquerVariables('Bonjour {prenom}, {lienAvis}', vars), 'Bonjour Julien, https://x.test/a');
  });

  await t.test('une variable inconnue reste visible plutôt que de laisser un trou', () => {
    const r = avis.appliquerVariables('Bonjour {prenom}, code {inexistant}', { prenom: 'Julien' });
    assert.equal(r, 'Bonjour Julien, code {inexistant}');
  });

  await t.test('commande invité : le prénom vient de l\'adresse de livraison', () => {
    const vars = avis.variablesCommande({ order: commande, user: null });
    assert.equal(vars.prenom, 'Julien');
    assert.equal(vars.nom, 'Farge');
  });
});

test('les trois canaux portent le lien', async (t) => {
  await t.test('chaque modèle par défaut passe par l\'enquête', () => {
    avis.CANAUX.forEach((canal) => {
      /* {lienEnquete} et pas {lienAvis} : le client passe d'abord par la page
         « quelle note ? ». Enquête coupée, la variable retombe sur le lien
         Google — un modèle sans aucun lien ne doit jamais exister. */
      assert.match(avis.DEFAUTS[canal].corps, /\{lienEnquete\}/, canal + ' doit contenir le lien');
    });
  });

  await t.test('sans enquête fournie, le lien Google prend le relais', async () => {
    const r = await avis.resoudre('email', { order: commande, user: client });
    assert.ok(r.corps.includes(avis.LIEN_PAR_DEFAUT), 'un message sans lien ne doit jamais partir');
  });

  await t.test('avec une enquête, c\'est elle qui est dans le message', async () => {
    const r = await avis.resoudre('email', { order: commande, user: client, lienEnquete: 'https://autoliva.com/mon-avis/abc' });
    assert.ok(r.corps.includes('https://autoliva.com/mon-avis/abc'));
    assert.ok(!r.corps.includes(avis.LIEN_PAR_DEFAUT), 'pas de lien Google direct quand l\'enquête est en place');
  });

  await t.test('le SMS par défaut tient en UN segment, lien compris', async () => {
    /* La contrainte qui a dicté le texte du SMS. On la mesure sur le pire cas
       réel : le lien d'enquête (plus long que le lien Google), un jeton émis
       par le vrai générateur, et un n° de commande au format de production.
       Deux segments doublent le coût de chaque envoi — si ce test casse, c'est
       le texte qu'il faut raccourcir, pas la limite. */
    const token = reviewFeedback.nouveauToken();
    const lienEnquete = `${brand.SITE_URL}/mon-avis/${token}`;
    const r = await avis.resoudre('sms', { order: commande, user: client, lienEnquete });
    assert.ok(r.corps.includes(lienEnquete), 'le lien doit être présent');
    assert.ok(!/\{\w+\}/.test(r.corps), 'aucune variable ne doit rester : ' + r.corps);
    assert.ok(r.corps.length <= 160, `un seul segment (160) attendu, mesuré ${r.corps.length} : ${r.corps}`);
  });

  await t.test('le SMS reste en GSM-7 : pas de caractère qui ferait tomber à 70', () => {
    /* Un seul caractère hors GSM-7 (œ, guillemets typographiques, emoji…)
       bascule tout le SMS en UCS-2 : la limite passe de 160 à 70 et le texte
       part en deux segments sans qu'on ait rien allongé. */
    const GSM7 = /^[@£$¥èéùìòÇØøÅåÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\r\n]*$/;
    const sansVariables = avis.DEFAUTS.sms.corps.replace(/\{\w+\}/g, '');
    assert.ok(GSM7.test(sansVariables), 'caractère hors GSM-7 dans : ' + sansVariables);
  });
});

test('réglages back-office', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => { await mongoose.disconnect(); await serveur.stop(); });

  await t.test('sans réglage enregistré : lien et textes par défaut', async () => {
    const r = await avis.resoudre('email', { order: commande, user: client });
    assert.equal(r.enabled, true);
    assert.equal(r.lienAvis, avis.LIEN_PAR_DEFAUT);
    assert.match(r.sujet, /CP2026-000485/);
  });

  await t.test('un lien personnalisé remplace le défaut partout', async () => {
    const ok = await avis.enregistrer({
      lienAvis: 'https://search.google.com/local/writereview?placeid=ABC&hl=fr',
      email: { enabled: true }, sms: { enabled: true }, whatsapp: { enabled: true },
    }, 'Test');
    assert.equal(ok.ok, true);
    for (const canal of avis.CANAUX) {
      const r = await avis.resoudre(canal, { order: commande, user: client });
      assert.ok(r.corps.includes('writereview?placeid=ABC&hl=fr'), canal + ' doit utiliser le nouveau lien');
    }
  });

  await t.test('un lien qui n\'est pas une URL est refusé', async () => {
    const r = await avis.enregistrer({ lienAvis: 'javascript:alert(1)' }, 'Test');
    assert.equal(r.ok, false);
    /* Et le lien précédent n'a pas bougé : un refus ne doit pas laisser le
       réglage à moitié écrit. */
    const lien = await avis.getLien();
    assert.ok(lien.startsWith('https://search.google.com/'), lien);
  });

  await t.test('un texte vidé revient au défaut au lieu d\'envoyer du vide', async () => {
    await avis.enregistrer({
      lienAvis: '', email: { enabled: true, sujet: '', corps: '   ' },
      sms: { enabled: true }, whatsapp: { enabled: true },
    }, 'Test');
    const r = await avis.resoudre('email', { order: commande, user: client });
    assert.equal(r.lienAvis, avis.LIEN_PAR_DEFAUT, 'lien vide → défaut');
    assert.ok(r.corps.includes(avis.LIEN_PAR_DEFAUT));
    assert.ok(r.corps.trim().length > 50, 'corps vide → défaut');
  });

  await t.test('un canal désactivé est signalé comme tel', async () => {
    await avis.enregistrer({
      lienAvis: '', email: { enabled: true }, sms: { enabled: false }, whatsapp: { enabled: true },
    }, 'Test');
    assert.equal((await avis.resoudre('sms', { order: commande })).enabled, false);
    assert.equal((await avis.resoudre('email', { order: commande })).enabled, true);
  });
});

test("gabarit e-mail", async (t) => {
  const lien = 'https://share.google/abc?a=1&b=2';

  await t.test('un lien seul sur sa ligne devient le bouton, et n\'est pas dupliqué', () => {
    const m = buildAvisGoogleEmail({
      order: commande, user: client, baseUrl: 'https://autoliva.com',
      sujet: 'Objet', corps: 'Bonjour Julien,\n\n' + lien + '\n\nMerci', lienAvis: lien,
    });
    assert.match(m.html, /Laisser un avis sur Google/);
    assert.equal((m.html.match(/Laisser un avis sur Google/g) || []).length, 1);
    /* L'URL doit être échappée dans le href (le & devient &amp;) : sans ça,
       un lien à plusieurs paramètres casse dans certains clients mail. */
    assert.match(m.html, /href="https:\/\/share\.google\/abc\?a=1&amp;b=2"/);
  });

  await t.test('un lien au fil du texte reste cliquable', () => {
    const m = buildAvisGoogleEmail({
      order: commande, user: client, baseUrl: 'https://autoliva.com',
      sujet: 'Objet', corps: 'Votre avis ici : ' + lien + ' — merci !', lienAvis: lien,
    });
    assert.match(m.html, /<a href="https:\/\/share\.google\/abc\?a=1&amp;b=2"/);
  });

  await t.test('lien retiré du texte : le bouton est ajouté quand même', () => {
    const m = buildAvisGoogleEmail({
      order: commande, user: client, baseUrl: 'https://autoliva.com',
      sujet: 'Objet', corps: 'Bonjour Julien, merci pour votre commande.', lienAvis: lien,
    });
    assert.match(m.html, /Laisser un avis sur Google/);
    assert.ok(m.text.includes(lien), 'la version texte doit aussi porter le lien');
  });

  await t.test('le HTML du client est échappé, pas interprété', () => {
    const m = buildAvisGoogleEmail({
      order: commande, user: { firstName: '<script>x</script>' },
      baseUrl: 'https://autoliva.com', sujet: 'Objet',
      corps: 'Bonjour <script>alert(1)</script>', lienAvis: lien,
    });
    assert.ok(!m.html.includes('<script>alert(1)</script>'));
    assert.match(m.html, /&lt;script&gt;/);
  });
});
