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

  await t.test("le lien par défaut ouvre le FORMULAIRE d'avis, pas la fiche", () => {
    /* Le premier lien retenu était un lien de partage (share.google/…) : il
       ouvrait le profil de l'établissement, et il fallait encore y trouver
       « Rédiger un avis ». Un écran de plus chez quelqu'un qui nous rend
       service. Ce test interdit d'y revenir sans s'en rendre compte. */
    assert.match(
      avis.LIEN_PAR_DEFAUT,
      /^https:\/\/search\.google\.com\/local\/writereview\?placeid=[A-Za-z0-9_-]+$/,
      'le défaut doit être un lien « écrire un avis » direct : ' + avis.LIEN_PAR_DEFAUT
    );
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

  /* Longueur GSM-7 : le € n'est pas dans la table de base, il vit dans la
     table d'extension et compte DOUBLE. Un décompte naïf annonce un segment
     là où l'opérateur en facture deux. */
  const longueurSms = (txt) => txt.length + (txt.match(/€/g) || []).length;
  const pireCommande = { number: 'CP2026-000485', items: [{ name: 'Arbre de transmission AV gauche renforcé' }] };
  const pireClient = { firstName: 'Jean-Christophe', lastName: 'de la Villardière' };

  await t.test('le SMS ne dépasse JAMAIS deux segments', async () => {
    /* Deux segments sont assumés : toutes les formulations qui ne font pas
       « SMS d'arnaque » dépassent 160 caractères une fois le lien et le nom
       de la pièce comptés. Le second segment coûte quelques centimes, un
       message qui inspire la méfiance coûte le client.
       Trois segments, en revanche, veut dire que le texte a dérivé.
       On compose le pire message possible pour la marque RÉELLEMENT
       déployée : prénom composé, pièce au maximum de la troncature, vrai
       domaine, vrai jeton. */
    const lienEnquete = `${brand.SITE_URL}/mon-avis/${reviewFeedback.nouveauToken()}`;
    const r = await avis.resoudre('sms', { order: pireCommande, user: pireClient, lienEnquete });
    const n = longueurSms(r.corps);
    assert.ok(n <= 306, `deux segments max (306) pour ${brand.NAME}, mesuré ${n} : ${r.corps}`);
  });

  await t.test('sans bon d\'achat, le SMS retombe à un seul segment', async () => {
    /* La clause du bon porte sa propre virgule : en disparaissant elle ne
       doit laisser ni ponctuation orpheline ni double espace. Et le message
       nu doit redevenir le SMS d'un segment qu'il était. */
    const lienEnquete = `${brand.SITE_URL}/mon-avis/${reviewFeedback.nouveauToken()}`;
    const vars = avis.variablesCommande({
      order: { number: 'CP2026-000485', items: [{ name: 'Mécatronique DQ200' }] },
      user: { firstName: 'Julien' },
      lienEnquete,
      bon: { actif: false },
    });
    const corps = avis.nettoyerTexte(avis.appliquerVariables(avis.DEFAUTS.sms.corps, vars));
    assert.ok(!/ ,|, :|\s{2}/.test(corps), 'ponctuation orpheline : ' + corps);
    const n = longueurSms(corps);
    assert.ok(n <= 160, `un seul segment attendu sans bon, mesuré ${n} : ${corps}`);
  });

  await t.test('le nom de pièce est coupé sur un mot entier', () => {
    const long = { items: [{ name: 'Mécatronique DQ200 0AM325065S Audi A3 Sportback' }] };
    assert.equal(avis.nomPiece(long), 'mécatronique DQ200');
    /* Minuscule initiale au milieu d'une phrase, mais jamais sur un sigle. */
    assert.equal(avis.nomPiece({ items: [{ name: 'TCU DQ381' }] }), 'TCU DQ381');
    /* Sans article : le gabarit écrit « Votre {piece} », qui marche aux deux
       genres — « cette {piece} » aurait donné « cette moteur ». */
    assert.equal(avis.nomPiece({ items: [] }), 'commande');
    assert.equal(avis.nomPiece(null), 'commande');
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

test("gabarit e-mail — lettre + signature", async (t) => {
  const lien = 'https://autoliva.com/mon-avis/abc?a=1&b=2';

  await t.test("aucune trace du gabarit marketing", () => {
    const m = buildAvisGoogleEmail({ sujet: 'Objet', corps: 'Bonjour,\n\n' + lien, lien });
    /* Ce qui classait l'e-mail en Promotions : un logo en bandeau d'en-tête,
       un gros bouton coloré, un pied de page. Rien de tout ça ne doit
       revenir — c'est tout l'objet de ce format. */
    assert.ok(!/Laisser un avis sur Google/.test(m.html), 'plus de bouton de campagne');
    assert.ok(!/Besoin d/.test(m.html), 'plus de pied de page du gabarit');
    assert.ok(!/bgcolor="#ec1313"/.test(m.html), 'plus de bouton rouge');
  });

  await t.test("un lien seul sur sa ligne devient un lien NOMMÉ, pas une URL nue", () => {
    const m = buildAvisGoogleEmail({ sujet: 'Objet', corps: 'Bonjour,\n\n' + lien + '\n\nMerci', lien });
    assert.match(m.html, /Donner mon avis en 10 secondes/);
    /* L'URL doit être échappée dans le href (le & devient &amp;) : sans ça,
       un lien à plusieurs paramètres casse dans certains clients mail. */
    assert.match(m.html, /href="https:\/\/autoliva\.com\/mon-avis\/abc\?a=1&amp;b=2"/);
  });

  await t.test('un lien au fil du texte reste cliquable', () => {
    const m = buildAvisGoogleEmail({ sujet: 'Objet', corps: 'Votre avis ici : ' + lien + ' — merci !', lien });
    assert.match(m.html, /<a href="https:\/\/autoliva\.com\/mon-avis\/abc\?a=1&amp;b=2"/);
  });

  await t.test('la signature de la maison est présente, dans les deux parties', () => {
    const m = buildAvisGoogleEmail({ sujet: 'Objet', corps: 'Bonjour,', lien });
    for (const partie of [m.html, m.text]) {
      assert.match(partie, /Service Client/);
      assert.ok(partie.includes(brand.PHONE), 'le téléphone doit venir de brand.js');
      assert.ok(partie.includes(brand.EMAIL_CONTACT));
    }
    assert.match(m.html, /logo-autoliva\.png|logo-v2\.png/, 'le logo doit être en absolu');
    /* Lisible sans images : rien d'important n'est dans le logo, et il porte
       un alt. La plupart des clients bloquent les images par défaut. */
    assert.match(m.html, /alt="/);
  });

  await t.test('le HTML du corps est échappé, pas interprété', () => {
    const m = buildAvisGoogleEmail({ sujet: 'Objet', corps: 'Bonjour <script>alert(1)</script>', lien });
    assert.ok(!m.html.includes('<script>alert(1)</script>'));
    assert.match(m.html, /&lt;script&gt;/);
  });
});
