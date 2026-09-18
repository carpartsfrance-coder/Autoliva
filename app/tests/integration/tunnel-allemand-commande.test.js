/**
 * Le parcours allemand DE BOUT EN BOUT, servi par la vraie application (09/2026) :
 * carte produit, fiche, panier, livraison, paiement, confirmation, suivi,
 * compte — et le client français qui ne doit rien voir changer.
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production).
 *
 * Ce qu'on verrouille (revue du 17/09/2026) :
 *   - les appels de données d'une page /de (/api/vehicules, autocomplétion) ne
 *     remettent plus la session en français ;
 *   - le port et le Pfand sont annoncés sur les cartes allemandes, avant leur
 *     bouton d'ajout direct au panier (PAngV) ;
 *   - la FAQ « Pfand » suit le bloc « échange standard », le délai de retour
 *     est partout celui de la fiche ;
 *   - la consigne NON encaissée est rappelée jusqu'au bouton de commande ;
 *   - les erreurs du tunnel sont en allemand, « compte existant » avec un lien ;
 *   - la confirmation distingue la consigne encaissée, l'exclut de la TVA, et
 *     parle allemand (pays, noms d'articles, support, délai selon le pays) ;
 *   - l'inscription garde la langue et range un n° de TVA UE à sa place.
 *
 * Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions en mémoire),
 * paiement simulé localement, serveur sur un port éphémère.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI; // sessions en mémoire, jamais de base externe
delete process.env.SCALAPAY_ENABLED;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY', 'SKEEPERS_API_KEY', 'JUMINGO_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const FIXTURE = require('../fixtures/fiches-produit-prod.json');
/* L'intitulé imprimé par la facture pour le numéro d'entreprise du client. */
const { intituleNumeroEntreprise } = require('../../src/services/invoicePdf');
const DQ200 = FIXTURE.produits.find((p) => p.sku.startsWith('0AM'));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function versMongo(p, patch = {}) {
  const doc = JSON.parse(JSON.stringify(p));
  delete doc._role;
  doc._id = new mongoose.Types.ObjectId(patch._id || p._id);
  delete patch._id;
  doc.localizations.de.translatedAt = new Date(doc.localizations.de.translatedAt || Date.now());
  return Object.assign(doc, patch);
}

/* Copie de la DQ200 : même fiche traduite, consigne et FAQ au choix. */
function copieDq200(suffixe, patch) {
  const id = new mongoose.Types.ObjectId();
  const doc = versMongo(DQ200, { _id: String(id), ...patch });
  doc.sku = `ZZT-${suffixe}`;
  doc.slug = `zzt-${suffixe.toLowerCase()}-${DQ200.slug}`;
  doc.localizations.de.slug = `zzt-${suffixe.toLowerCase()}-${DQ200.localizations.de.slug}`;
  doc.faqs = [];
  doc.localizations.de.faqs = [];
  return doc;
}

function texte(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const langueHtml = (html) => (String(html).match(/<html[^>]*\blang="([a-z]+)"/) || [])[1];

/** « 1 157,50 € » → 115750 (l'espace est une espace insécable étroite). */
function centimes(montant) {
  return Math.round(Number(String(montant).replace(/[^0-9,]/g, '').replace(',', '.')) * 100);
}

/**
 * Le récapitulatif de la page commande doit S'ADDITIONNER : chaque ligne
 * au-dessus du trait, puis le total. La décomposition HT/TVA vient APRÈS le
 * total et n'est pas un terme de la somme.
 */
function recapitulatifCommande(html) {
  const debut = html.indexOf('<div class="space-y-3 text-sm">');
  const fin = html.indexOf('/racheter', debut);
  const bloc = debut >= 0 && fin > debut ? html.slice(debut, fin) : '';
  const avantTotal = bloc.split('border-t border-slate-200')[0] || '';
  const lignes = (texte(avantTotal).match(/-?\s?\d[\d  ]*,\d{2} €/g) || []).map((m) => (m.trim().startsWith('-') ? -centimes(m) : centimes(m)));
  const apresTotal = bloc.split('border-t border-slate-200')[1] || '';
  const total = centimes((texte(apresTotal).match(/\d[\d  ]*,\d{2} €/) || [])[0] || '0');
  return { sommeLignes: lignes.reduce((a, b) => a + b, 0), total, texte: texte(bloc) };
}

/** Un navigateur minimal : cookie de session conservé, navigations HTML. */
function navigateur(base) {
  let cookie = '';
  async function requete(chemin, { method = 'GET', form, headers = {} } = {}) {
    const h = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', ...headers };
    if (cookie) h.cookie = cookie;
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const r = await fetch(base + chemin, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      if (c.startsWith('carpartsfrance.sid=')) cookie = c.split(';')[0];
    }
    const html = await r.text();
    return { status: r.status, location: r.headers.get('location'), html, lu: texte(html) };
  }
  /* fetch() lancé par une page : métadonnées complètes d'un navigateur. */
  requete.appelDonnees = (chemin) => requete(chemin, { headers: { accept: '*/*', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
  return requete;
}

test('parcours allemand de bout en bout (application réelle)', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  await db.collection('shippingclasses').insertOne({
    name: 'Colis', slug: 'colis', isActive: true, isDefault: true, domicilePriceCents: 6900, zonePricesCents: { metropole: 6900, europe: 9900 },
  });

  const upfront = versMongo(DQ200); // consigne de 99 € encaissée à la commande
  const conditionnelle = copieDq200('CORE', { consigne: { enabled: true, amountCents: 15000, delayDays: 15, chargeUpfront: false } });
  const sansConsigne = copieDq200('SANS', { consigne: { enabled: false, amountCents: 0, delayDays: 30, chargeUpfront: false } });
  const clonage = copieDq200('CLONE', { serviceType: 'standalone_cloning', consigne: { enabled: false, amountCents: 0, delayDays: 30, chargeUpfront: false } });
  /* Fiche à 19,90 € (les centimes comptent sur la carte) et à options (le résumé
     figé dans le panier porte la typographie de la langue). */
  const petitPrix = copieDq200('PETIT', {
    priceCents: 1990,
    consigne: { enabled: false, amountCents: 0, delayDays: 30, chargeUpfront: false },
    specs: [{ label: 'Programmation', value: 'Programmé au VIN' }],
    options: [{
      key: 'programmation', label: 'Programmation', type: 'choice', required: false,
      choices: [{ key: 'avec', label: 'Avec programmation', priceDeltaCents: 0 }],
    }],
  });
  petitPrix.localizations.de.specs = [{ label: 'Programmierung', value: 'Auf VIN programmiert' }];
  /* Sans spec « Typ » : la carte retombe sur la CATÉGORIE, qui doit être
     traduite elle aussi (elle sortait en français sous un titre allemand). */
  const sansSpecs = copieDq200('CAT', { specs: [], consigne: { enabled: false, amountCents: 0, delayDays: 30, chargeUpfront: false } });
  sansSpecs.localizations.de.specs = [];
  await db.collection('products').insertMany([upfront, conditionnelle, sansConsigne, clonage, petitPrix, sansSpecs]);

  /* Catégorie traduite : le fil d'Ariane de la fiche allemande et le libellé
     « Typ » des cartes s'y rapportent (Product.category n'est qu'une chaîne). */
  await db.collection('categories').insertOne({
    name: 'Mécatroniques & calculateurs', slug: 'zzt-mecatroniques', isActive: true, sortOrder: 1,
    localizations: { de: { name: 'Mechatronik & Steuergeräte', slug: 'zzt-mechatronik', translatedAt: new Date() } },
  });

  /* Page légale SANS version allemande : l'état normal en production, et le
     lien « AGB » obligatoire du paiement y mène. */
  await db.collection('legalpages').insertOne({
    slug: 'cgv', title: 'Conditions générales de vente', contentHtml: '<p>CGV</p>', isPublished: true,
    localizations: { de: { title: '', contentHtml: '', translatedAt: null } },
  });

  await db.collection('users').insertOne({
    accountType: 'particulier', firstName: 'Erika', lastName: 'Mustermann', email: 'existe-deja@example.com', lang: 'de',
    passwordSalt: 'x', passwordHash: 'y', addresses: [], createdAt: new Date(), updatedAt: new Date(),
  });

  const app = require('../../src/app');
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const ficheDe = (p) => `/de/produits/${encodeURIComponent(p.localizations.de.slug)}-${p._id}`;
  const ficheFr = (p) => `/product/${p.slug}/`;

  await t.test('les appels de données d’une page /de ne remettent pas le français', async () => {
    const nav = navigateur(base);
    const accueil = await nav('/de/');
    assert.equal(langueHtml(accueil.html), 'de');
    /* Lancés d'eux-mêmes par l'accueil (sélecteur de véhicule) et l'autocomplétion. */
    await nav.appelDonnees('/api/vehicules');
    await nav.appelDonnees('/rechercher/suggest?q=dq200');

    const panier = await nav('/panier');
    assert.equal(langueHtml(panier.html), 'de', 'un appel de données a remis la session en français');
    /* Panier vide : « Weiter einkaufen » et le menu restent dans le catalogue allemand. */
    assert.match(panier.html, /href="\/de\/produits">\s*Weiter einkaufen/, '« Weiter einkaufen » mène au catalogue français');
    assert.ok(!/href="\/produits"/.test(panier.html), 'lien de navigation vers une page française sur le panier allemand');
    assert.match(panier.html, /"cartHref":"\/de\/panier"/, 'toast d’ajout au panier sans préfixe allemand');
    assert.match(panier.html, /"added":"Produkt zum Warenkorb hinzugefügt"/, 'toast d’ajout au panier en français');

    /* Menu d'autocomplétion de la recherche : le serveur répond déjà en
       allemand (titres de sections, noms de fiches), mais le calque client
       réinjectait du français EN DUR (« Réf: », « Catégorie », « Marque
       véhicule », « 3 résultats »). Les libellés viennent maintenant de
       window.CPF_SEARCH_I18N, posé par le header dans la langue de la page. */
    const i18nRecherche = (accueil.html.match(/window\.CPF_SEARCH_I18N = (\{.*?\});/) || [])[1];
    assert.ok(i18nRecherche, 'libellés d’autocomplétion non exposés sur une page allemande');
    const libelles = JSON.parse(i18nRecherche);
    assert.deepEqual(
      { ref: libelles.ref, product: libelles.product, vehicleMake: libelles.vehicleMake, category: libelles.category },
      { ref: 'Ref.:', product: 'Produkt', vehicleMake: 'Fahrzeugmarke', category: 'Kategorie' },
    );
    assert.equal(libelles.countResults, '%count% Treffer');
    assert.equal(libelles.allResultsFor, 'Alle Ergebnisse für „%q%“ anzeigen');
    /* Le lien « tout voir » du panneau garde le préfixe /de : écrasé en
       « /produits » par le script, il renvoyait l'acheteur allemand sur le
       catalogue FRANÇAIS, dont le GET remet la session en « fr ». */
    assert.match(accueil.html, /href="\/de\/produits" data-search-autocomplete-all/, 'lien « tout voir » de la recherche sans préfixe allemand');

    /* Une vraie navigation vers une page française, elle, remet « fr ». */
    await nav('/contact');
    assert.equal(langueHtml((await nav('/panier')).html), 'fr');
  });

  await t.test('les liens des pages allemandes ne ramènent jamais au français', async () => {
    const nav = navigateur(base);
    await nav('/de/');
    assert.equal(langueHtml((await nav('/panier')).html), 'de');

    /* La loupe du header et l'onglet « Suchen » : une VRAIE page allemande. */
    const recherche = await nav('/de/rechercher');
    assert.equal(recherche.status, 200, '/de/rechercher n’a pas de routeur');
    assert.equal(langueHtml(recherche.html), 'de');
    assert.ok(recherche.lu.includes('Suchen') && recherche.lu.includes('Katalog öffnen'), recherche.lu.slice(0, 200));
    assert.match(recherche.html, /<form action="\/de\/produits"/, 'la recherche allemande poste vers le catalogue français');
    assert.equal(langueHtml((await nav('/panier')).html), 'de', 'la recherche a remis la session en français');

    /* Les /de sans traduction (moteurs, notre-histoire…) redirigent vers le
       français SANS perdre la langue : c'est tout l'objet du ?lang=de. */
    for (const url of ['/de/moteurs', '/de/notre-histoire']) {
      const r = await nav(url);
      assert.equal(r.status, 301, `${url} : ${r.status}`);
      assert.equal(r.location, `${url.replace('/de', '')}?lang=de`, `${url} → ${r.location}`);
      await nav(r.location);
      assert.equal(langueHtml((await nav('/panier')).html), 'de', `${url} a remis la session en français`);
    }

    /* Page légale sans version allemande : même règle. C'est le lien « AGB »
       obligatoire, juste au-dessus du bouton de commande. */
    const cgv = await nav('/de/legal/cgv');
    assert.equal(cgv.status, 301);
    assert.equal(cgv.location, '/legal/cgv?lang=de');
    await nav(cgv.location);
    assert.equal(langueHtml((await nav('/panier')).html), 'de', 'ouvrir les AGB a remis la commande en français');

    /* Pages françaises sans équivalent allemand, liées depuis le bandeau de
       sécurité (toutes les pages, tunnel compris) et depuis le bouton SAV
       flottant (masqué sur le tunnel) : le lien porte la langue. */
    const panier = await nav('/panier');
    assert.match(panier.html, /href="\/securite\?lang=de"/, 'lien « So erkennen Sie uns » sans la langue');
    const home = await nav('/de/');
    assert.match(home.html, /href="\/sav\/suivi\?lang=de"/, 'bouton SAV sans la langue');
    await nav('/securite?lang=de');
    assert.equal(langueHtml((await nav('/panier')).html), 'de');

    /* Accueil allemand : le bouton le plus visible (devis) et le blog restent
       allemands, le popup de sortie aussi. */
    const accueil = await nav('/de/');
    assert.match(accueil.html, /href="\/de\/devis"/, 'le CTA du hero mène au formulaire français');
    assert.ok(!/href="\/devis"/.test(accueil.html), 'lien /devis non préfixé sur la home allemande');
    assert.match(accueil.html, /href="\/de\/blog"/, '« Blog entdecken » mène au blog français');
    assert.match(accueil.html, /href="\/de\/legal\/confidentialite"/, 'popup de sortie : confidentialité française');

    /* Un ROBOT, lui, ne doit pas se voir proposer d'URL paramétrée. */
    const robot = await fetch(`${base}/de/moteurs`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', accept: 'text/html' },
      redirect: 'manual',
    });
    assert.equal(robot.headers.get('location'), '/moteurs', 'Googlebot reçoit une URL paramétrée');
  });

  await t.test('accueil et fiche /de : sélecteur, logos de marque et maillage gardent l’allemand', async () => {
    const nav = navigateur(base);
    const accueil = await nav('/de/');

    /* Sélecteur de véhicule : son bouton est en allemand, mais il postait vers
       le catalogue FRANÇAIS et ce GET remettait toute la session en « fr ». */
    assert.match(accueil.html, /<form action="\/de\/produits" method="GET" class="vehicle-selector/, 'le sélecteur de véhicule poste vers le catalogue français');

    /* Les 18 logos de marque : pages qui n'existent qu'en français → ?lang=de. */
    assert.match(accueil.html, /href="\/pieces-auto\/audi\?lang=de"/, 'logo de marque sans la langue');
    assert.ok(!/href="\/pieces-auto\/[a-z-]+"/.test(accueil.html), 'un lien marque nu subsiste sur l’accueil allemand');
    assert.match(accueil.html, /aria-label="Teile für Audi ansehen"/, 'libellé d’accessibilité français sur l’accueil allemand');
    await nav('/pieces-auto/audi?lang=de');
    assert.equal(langueHtml((await nav('/panier')).html), 'de', 'le clic sur un logo de marque a remis la commande en français');

    /* Maillage interne de la fiche — la page d'atterrissage des annonces. */
    const fiche = await nav(ficheDe(upfront));
    const maillage = (fiche.html.match(/class="pp-links"[\s\S]*?<\/section>/) || [])[0] || '';
    if (maillage) {
      assert.ok(!/href="\/(pieces-auto|categorie)\/[^"?]*"/.test(maillage), `maillage : lien français nu « ${(maillage.match(/href="[^"]*"/g) || []).join(' ')} »`);
    }
    assert.match(fiche.html, /href="\/de\/produits"/, '« Alle Teile im Katalog » mène au catalogue français');
    assert.ok(!/href="\/produits"/.test(fiche.html), 'lien /produits nu sur la fiche allemande');
    assert.ok(!/href="\/blog"/.test(fiche.html), 'lien /blog nu sur la fiche allemande');

    /* Étiquettes d'accessibilité et textes alternatifs de la fiche. */
    assert.match(fiche.html, /aria-label="Brotkrümelnavigation"/, 'fil d’Ariane annoncé en français');
    assert.ok(!/aria-label="Fil d'Ariane"/.test(fiche.html) && !/ — vue \d/.test(fiche.html), 'texte français dans un attribut de la fiche allemande');
    assert.ok(!/aria-label="(Navigation rapide|Ajouter aux favoris|Image (précédente|suivante)|Agrandir)"/.test(fiche.html), 'attribut d’accessibilité français sur la fiche allemande');

    /* Repli du toast d'ajout au panier : il s'affiche quand la réponse n'est pas
       du JSON (429 du limiteur, 502 de la plateforme) et restait en français. */
    assert.ok(fiche.html.includes('Das Produkt kann derzeit nicht zum Warenkorb hinzugefügt werden.'), 'repli du toast absent de la fiche allemande');
    assert.ok(!fiche.html.includes('Impossible d’ajouter le produit au panier pour le moment.'), 'repli français dans le script de la fiche allemande');
    /* Et le limiteur, qui s'exécute avant le middleware i18n, répond désormais
       en JSON quand l'appel en demande — sinon le toast jetait le message. */
    const { langueAvantI18n, attendDuJson } = app.__limiteurs;
    assert.equal(langueAvantI18n({ path: '/de/produits', session: {} }), 'de');
    assert.equal(langueAvantI18n({ path: '/panier/ajouter/x', session: { preferredLang: 'de' } }), 'de', 'URL française du tunnel : la préférence fait foi');
    assert.equal(langueAvantI18n({ path: '/produits', session: {} }), 'fr');
    assert.equal(attendDuJson({ headers: { 'x-requested-with': 'XMLHttpRequest' } }), true);
    assert.equal(attendDuJson({ headers: { accept: 'text/html' } }), false);

    /* Bannière de suggestion de langue : réservée à un navigateur qui demande le
       FRANÇAIS. Elle s'affichait pour tout navigateur non allemand (en-US, nl,
       pl…) et son bouton faisait basculer paiement, Order.lang et e-mails. */
    const entetes = (al) => ({ 'user-agent': UA, accept: 'text/html', 'accept-language': al });
    const anglais = await fetch(base + ficheDe(upfront), { headers: entetes('en-US,en;q=0.9') });
    assert.ok(!(await anglais.text()).includes('id="lang-suggest"'), 'bandeau français proposé à un navigateur anglophone');
    const francais = await fetch(base + ficheDe(upfront), { headers: entetes('fr-FR,fr;q=0.9') });
    assert.ok((await francais.text()).includes('id="lang-suggest"'), 'le visiteur francophone ne se voit plus proposer le français');

    /* Français : aucun paramètre, aucun préfixe, libellés inchangés. */
    const accueilFr = await navigateur(base)('/');
    assert.match(accueilFr.html, /<form action="\/produits" method="GET" class="vehicle-selector/);
    assert.match(accueilFr.html, /href="\/pieces-auto\/audi" aria-label="Voir les pièces pour Audi"/);
    assert.ok(!accueilFr.html.includes('lang=de'), 'paramètre de langue sur l’accueil français');
  });

  await t.test('menu déroulant du header : noms, sections et liens allemands', async () => {
    const nav = navigateur(base);
    await nav('/de/');
    /* Même session que la page /de : c'est elle qui donne la langue (l'URL de
       l'autocomplétion, elle, est toujours française). */
    const suggest = await nav('/rechercher/suggest?q=DQ200', { headers: { accept: '*/*', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
    const payload = JSON.parse(suggest.html);
    const produits = payload.sections.find((x) => x.type === 'products');
    assert.equal(produits.title, 'Produkte', `titre de section : ${produits.title}`);
    assert.ok(produits.items[0].name.startsWith('Mechatronik'), `nom français dans le menu : ${produits.items[0].name}`);
    assert.match(produits.items[0].publicPath, /^\/de\/produits\//, `lien français dans le menu : ${produits.items[0].publicPath}`);
    const categories = payload.sections.find((x) => x.type === 'categories');
    assert.equal(categories.title, 'Kategorien');
    assert.equal(categories.items[0].label, 'Mechatronik & Steuergeräte', `catégorie non traduite : ${categories.items[0].label}`);
    assert.match(categories.items[0].href, /^\/de\/produits\?/);

    /* Un MOT ALLEMAND doit trouver la pièce : le préfiltre Mongo ignorait
       `localizations.de.*` (pas de langue passée) et, même retenue, la fiche
       était rejetée au classement, noté sur la version française. Le champ
       invite pourtant à taper en allemand (« Teil, Referenznummer oder Marke
       suchen… ») : on répondait « aucun résultat » à « Mechatronik ». */
    for (const mot of ['Mechatronik', 'Getriebe']) {
      const r = JSON.parse((await nav(`/rechercher/suggest?q=${encodeURIComponent(mot)}`, { headers: { accept: '*/*', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).html);
      assert.ok(r.results.length > 0, `« ${mot} » ne trouve rien dans le menu allemand`);
      assert.ok(r.results[0].name.startsWith('Mechatronik'), `« ${mot} » : ${r.results[0].name}`);
      assert.match(r.results[0].publicPath, /^\/de\/produits\//);
    }

    /* Cliquer un résultat garde l'allemand. */
    await nav(produits.items[0].publicPath);
    assert.equal(langueHtml((await nav('/panier')).html), 'de');

    /* Français : rien ne change. */
    const navFr = navigateur(base);
    await navFr('/produits');
    const suggestFr = JSON.parse((await navFr('/rechercher/suggest?q=DQ200', { headers: { accept: '*/*', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).html);
    assert.equal(suggestFr.sections[0].title, 'Produits');
    assert.match(suggestFr.sections[0].items[0].publicPath, /^\/product\//);
    const mecaFr = JSON.parse((await navFr('/rechercher/suggest?q=mecatronique', { headers: { accept: '*/*', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).html);
    assert.ok(mecaFr.results.length > 0 && mecaFr.results[0].name.startsWith('Mécatronique'), `menu français : ${JSON.stringify(mecaFr.results[0] || null)}`);
  });

  await t.test('cartes allemandes : port et Pfand annoncés avant l’ajout direct au panier', async () => {
    const nav = navigateur(base);
    const liste = await nav('/de/produits');
    assert.equal(liste.status, 200);
    assert.ok(liste.lu.includes('inkl. MwSt., zzgl. Versand'), 'carte sans « zzgl. Versand »');
    assert.ok(liste.lu.includes('zzgl. 99,00 € Altteilpfand'), 'carte sans le Pfand encaissé');

    const accueil = await nav('/de/');
    assert.ok(accueil.lu.includes('inkl. MwSt., zzgl. Versand'), 'accueil : carte sans « zzgl. Versand »');

    const fiche = await nav(ficheDe(upfront));
    const barre = texte((fiche.html.match(/class="ap-sticky-price"[\s\S]*?data-ap-sticky-add/) || [])[0]);
    assert.ok(barre.includes('inkl. MwSt., zzgl. Versand'), `barre collante : « ${barre} »`);
    assert.ok(barre.includes('zzgl. 99,00 € Altteilpfand'), `barre collante sans Pfand : « ${barre} »`);

    /* Libellés de carte et prix EXACT : « Référence / État / Type » restaient
       français à côté de « Passend für », et le prix était arrondi à l'euro
       (« 20 € » pour une pièce à 19,90 €) juste au-dessus de la mention
       « inkl. MwSt., zzgl. Versand ». */
    assert.ok(liste.lu.includes('Referenz') && liste.lu.includes('Zustand') && liste.lu.includes('Typ '), liste.lu.slice(0, 300));
    assert.ok(!/(^|\s)(Référence|État|Type)\s/.test(liste.lu), 'libellés de carte en français sur le catalogue allemand');
    assert.ok(liste.lu.includes('19,90 €'), 'prix arrondi sur la carte allemande');
    /* Sans spec « Typ », la carte affiche la catégorie — traduite. */
    assert.ok(liste.lu.includes('Typ Mechatronik & Steuergeräte'), 'catégorie française sur une carte allemande');
    assert.ok(!liste.lu.includes('Mécatroniques & calculateurs'), 'nom de catégorie français sur le catalogue allemand');
    assert.ok(!/\b20 €/.test(liste.lu), 'prix arrondi à l’euro sur la carte allemande');

    /* Fil d'Ariane de la fiche : la page d'atterrissage des annonces. */
    const fil = (fiche.html.match(/<nav[^>]*data-fil-ariane[\s\S]*?<\/nav>/) || [])[0] || '';
    assert.match(fil, /href="\/de\/"/, 'fil d’Ariane : « Startseite » mène au site français');
    assert.match(fil, /href="\/de\/produits"/, 'fil d’Ariane : « Katalog » mène au catalogue français');
    assert.match(fil, /\/de\/categorie\/zzt-mechatronik/, `fil d’Ariane : maillon catégorie « ${texte(fil)} »`);
    assert.equal((await nav('/de/categorie/zzt-mechatronik')).status, 200, 'le maillon catégorie répond 404');

    /* Pastilles de filtre actif et compteur : la facette disait « Auf Lager »
       et sa pastille « En stock », le fil d'Ariane et la pastille de catégorie
       affichaient le nom FRANÇAIS sous un H1 allemand, et le compteur écrivait
       « 1 Teile gefunden ». */
    const filtres = await nav('/de/produits?vehicleMake=Volkswagen&vehicleModel=Polo&stock=in&minPrice=100&maxPrice=2000');
    for (const attendu of ['Marke: Volkswagen', 'Modell: Polo', 'Auf Lager', 'Min. 100 €', 'Max. 2000 €']) {
      assert.ok(filtres.lu.includes(attendu), `pastille « ${attendu} » absente : ${filtres.lu.slice(0, 400)}`);
    }
    for (const francais of ['Marque :', 'Modèle :', 'Marke :', 'En stock', 'Min 100 €', 'Max 2000 €']) {
      assert.ok(!filtres.lu.includes(francais), `pastille française « ${francais} » sur le catalogue allemand`);
    }

    /* Bandeau « véhicule actif » : son bouton « Fahrzeug entfernen » pointait en
       dur sur le catalogue FRANÇAIS — même fuite que le sélecteur de véhicule,
       et le GET remettait la session (donc le paiement et les e-mails) en
       français. Les deux autres « effacer » de la page passent par _basePath. */
    assert.match(filtres.html, /href="\/de\/produits\?vehicleClear=1"/, 'le bouton « véhicule » mène au catalogue français');
    assert.ok(!/href="\/produits\?vehicleClear=1"/.test(filtres.html), 'lien « vehicleClear » nu sur le catalogue allemand');
    await nav('/de/produits?vehicleClear=1');
    assert.equal(langueHtml((await nav('/panier')).html), 'de', 'effacer le véhicule a remis la commande en français');

    const parCategorie = await nav(`/de/produits?mainCategory=${encodeURIComponent('Mécatroniques & calculateurs')}`);
    assert.ok(!parCategorie.lu.includes('Mécatroniques & calculateurs'), 'nom de catégorie français dans le fil d’Ariane ou la pastille');
    assert.ok((parCategorie.lu.match(/Mechatronik & Steuergeräte/g) || []).length >= 2, 'fil d’Ariane et pastille non traduits');

    const unSeul = await nav('/de/produits?minPrice=19&maxPrice=20');
    assert.ok(unSeul.lu.includes('1 Teil gefunden'), `singulier allemand : « ${(unSeul.lu.match(/\d+ Teile? gefunden/) || [])[0]} »`);
    const categorieDe = await nav('/de/categorie/zzt-mechatronik');
    assert.ok(!categorieDe.lu.includes('Mécatroniques & calculateurs'), 'pastille française sur la page catégorie allemande');

    /* Français : rien ne s'ajoute. */
    const listeFr = await navigateur(base)('/produits');
    assert.ok(!listeFr.lu.includes('hors frais de port'), 'carte française modifiée');
    assert.ok(listeFr.lu.includes('Référence') && listeFr.lu.includes('État'), 'libellés français modifiés');
    assert.ok(listeFr.lu.includes('19,90 €'), 'prix français arrondi');
    const filtresFr = await navigateur(base)('/produits?vehicleMake=Volkswagen&stock=in&minPrice=100');
    for (const attendu of ['Marque : Volkswagen', 'En stock', 'Min 100 €']) {
      assert.ok(filtresFr.lu.includes(attendu), `pastille française « ${attendu} » modifiée : ${filtresFr.lu.slice(0, 400)}`);
    }
    assert.match(filtresFr.html, /href="\/produits\?vehicleClear=1"/, 'le bouton « véhicule » français a changé d’URL');
    const unSeulFr = await navigateur(base)('/produits?minPrice=19&maxPrice=20');
    assert.ok(unSeulFr.lu.includes('1 pièce trouvée'), `singulier français : « ${(unSeulFr.lu.match(/\d+ pièces? trouvées?/) || [])[0]} »`);
  });

  await t.test('fiche : la FAQ « Pfand » et le délai suivent le bloc échange standard', async () => {
    const nav = navigateur(base);

    /* Reconditionnée sans consigne : le bloc échange dit « retour obligatoire ». */
    const sansFr = await nav(ficheFr(sansConsigne));
    assert.ok(sansFr.lu.includes('vous nous renvoyez obligatoirement l’ancienne'), 'jeu d’essai : bloc échange absent');
    assert.ok(sansFr.lu.includes('Le retour de votre ancienne pièce reste obligatoire (principe de l’échange standard) : étiquette prépayée fournie, renvoi sous 30 jours après réception.'), 'FAQ FR : retour obligatoire absent');
    assert.ok(!sansFr.lu.includes('aucun retour d’ancienne pièce n’est nécessaire'), 'FAQ FR contredit le bloc échange');

    const sansDe = await nav(ficheDe(sansConsigne));
    assert.ok(sansDe.lu.includes('Die Rückgabe Ihres Altteils bleibt verpflichtend'), 'FAQ DE : retour obligatoire absent');
    assert.ok(!sansDe.lu.includes('es muss kein Altteil zurückgesendet werden'), 'FAQ DE contredit le bloc échange');

    /* Consigne non encaissée, délai de 15 jours : un seul délai sur la fiche. */
    const coreDe = await nav(ficheDe(conditionnelle));
    assert.ok(coreDe.lu.includes('Rückgabe innerhalb von 15 Tagen erforderlich'), 'étape 4 sans le délai de la fiche');
    assert.ok(!coreDe.lu.includes('innerhalb von 30 Tagen'), 'un second délai (30 jours) reste affiché');
    assert.ok(coreDe.lu.includes('berechnen wir 150,00 €'), 'FAQ DE : montant facturé absent');
    const coreFr = await nav(ficheFr(conditionnelle));
    assert.ok(coreFr.lu.includes('Retour obligatoire sous 15 jours'), 'étape 4 FR sans le délai de la fiche');

    /* Service de clonage : réponse dédiée. */
    const cloneFr = await nav(ficheFr(clonage));
    assert.ok(cloneFr.lu.includes('Non. Ce service ne demande aucune consigne'), 'FAQ du service de clonage');
  });

  await t.test('tunnel invité allemand : consigne conditionnelle rappelée, erreurs en allemand', async () => {
    const nav = navigateur(base);
    await nav(ficheDe(conditionnelle));
    assert.equal((await nav(`/panier/ajouter/${conditionnelle._id}`, { method: 'POST', form: { qty: '1', returnTo: '/panier' } })).status, 302);

    const rappel = 'Altteilrückgabe innerhalb von 15 Tagen nach Erhalt erforderlich – sonst berechnen wir 150,00 €';
    const panier = await nav('/panier');
    assert.ok(panier.lu.includes(rappel), 'panier : consigne conditionnelle absente');

    /* Résumé d'options figé dans la ligne de panier : traduit ET dans la
       typographie allemande (pas d'espace avant les deux-points). */
    await nav(`/panier/ajouter/${petitPrix._id}`, { method: 'POST', form: { qty: '1', opt_programmation: 'avec', returnTo: '/panier' } });
    const avecOption = await nav('/panier');
    assert.ok(avecOption.lu.includes('Programmierung: Mit Programmierung'), `résumé d’options : « ${(avecOption.lu.match(/Programmierung[^•]{0,40}/) || [])[0]} »`);
    assert.ok(!avecOption.lu.includes('Programmierung : '), 'espace française avant les deux-points');

    await nav('/panier/code-promo', { method: 'POST', form: { code: 'FALSCH10' } });
    const refus = await nav('/panier');
    assert.ok(refus.lu.includes('Fehler Dieser Gutscheincode existiert nicht.'), 'code refusé : raison absente');
    assert.ok(!refus.lu.includes('Code promo introuvable'), 'raison du refus en français');

    const livraison = await nav('/commande/livraison?guest=1');
    assert.ok(livraison.lu.includes(rappel), 'livraison : consigne conditionnelle absente');
    assert.ok(livraison.lu.includes('Zustellung 2–4 Werktage nach Versand'), 'délai Allemagne sans « nach Versand »');
    /* Les exemples des champs vides étaient des formats FRANÇAIS : « 75001 »
       sous « Postleitzahl », « 06 12 34 56 78 » sous « Telefon ». */
    const exemples = (livraison.html.match(/placeholder="[^"]*"/g) || []).join(' ');
    for (const attendu of ['ihre@email.de', 'Musterstraße 12', '10115', 'Berlin', '+49 151 12345678', 'Max', 'Mustermann']) {
      assert.ok(exemples.includes(attendu), `exemple « ${attendu} » absent : ${exemples}`);
    }
    for (const francais of ['votre@email.com', '12 rue de la Paix', '75001', 'Paris', '06 12 34 56 78']) {
      assert.ok(!exemples.includes(francais), `exemple français « ${francais} » sur la livraison allemande`);
    }
    /* maxlength=5 = format FRANÇAIS : les codes postaux irlandais, néerlandais,
       portugais ou polonais dépassent 5 caractères. Hors France, l'attribut ne
       doit plus être rendu (le JS le resynchronise au 'change' du pays). */
    const champCp = (livraison.html.match(/<input[^>]*id="postalCode"[^>]*>/) || [''])[0];
    assert.ok(champCp, 'champ code postal introuvable sur la livraison allemande');
    assert.ok(!/maxlength/.test(champCp), `maxlength français sur le code postal allemand : ${champCp}`);

    const invite = {
      shippingMethod: 'domicile', email: 'existe-deja@example.com', firstName: 'Max', lastName: 'Muster',
      phone: '+4930123456', line1: 'Hauptstraße 1', postalCode: '10115', city: 'Berlin', country: 'Allemagne',
    };
    assert.equal((await nav('/commande/livraison', { method: 'POST', form: invite })).location, '/commande/paiement');

    const paiement = await nav('/commande/paiement');
    assert.ok(paiement.lu.includes('10115 Berlin • Deutschland'), 'pays affiché en français au paiement');
    /* Récapitulatif mobile : le rappel est juste avant le bouton de commande. */
    const recap = texte((paiement.html.match(/data-recap-mobile[\s\S]*?<\/button>/) || [])[0]);
    assert.ok(recap.includes(rappel), `récapitulatif au-dessus du bouton sans la consigne : « ${recap} »`);
    assert.ok(recap.indexOf(rappel) < recap.indexOf('Zahlungspflichtig bestellen'));
    /* Le total annoncé juste avant « Zahlungspflichtig bestellen » doit dire
       qu'il contient la TVA (§ 312j Abs. 2 BGB → art. 246a § 1 Abs. 1 Nr. 4
       EGBGB « einschließlich aller Steuern », PAngV § 3). « Gesamt » tout court
       ne le disait pas, et le mot MwSt. n'apparaissait nulle part sur la page,
       alors que le panier, la livraison et la confirmation l'écrivent tous. */
    assert.ok(recap.includes('Gesamt inkl. MwSt.'), `total sans mention de TVA au-dessus du bouton : « ${recap} »`);
    assert.ok(/Gesamt inkl\. MwSt\./.test(paiement.lu), 'aucune mention « inkl. MwSt. » sur la page de paiement allemande');
    assert.ok(!/Gesamt\s+\d/.test(paiement.lu), `total « Gesamt » nu sur la page de paiement : « ${(paiement.lu.match(/Gesamt[^A-Za-zÄÖÜäöü]{0,15}/g) || []).join(' | ')} »`);
    /* Typographie allemande : pas d'espace avant les deux-points (la même règle
       que le résumé d'options), juste au-dessus du champ FIN obligatoire.
       Sur le HTML brut, pas sur `lu` : texte() remplace chaque balise par une
       espace, donc « </span>: » et « </span> : » s'y ressemblent. */
    assert.match(paiement.html, /Erforderlich<\/span>: Wir prüfen/, `« Erforderlich » : ${(paiement.html.match(/Erforderlich<\/span>.{0,20}/) || [])[0]}`);

    await nav('/commande/paiement', { method: 'POST', form: { paymentMethod: 'mollie', vehicleIdentifierType: 'vin', vehicleVin: 'WVWZZZ1', acceptCgv: 'true' } });
    const vin = await nav('/commande/paiement');
    assert.ok(vin.lu.includes('Fehler Die FIN scheint zu kurz zu sein. Bitte überprüfen Sie sie.'), 'FIN trop courte : message français');

    /* Client revenu commander en invité avec l'e-mail de son compte. */
    const existe = await nav('/commande/paiement', { method: 'POST', form: { paymentMethod: 'mollie', vehicleIdentifierType: 'vin', vehicleVin: 'WVWZZZ1KZAW000001', acceptCgv: 'true' } });
    assert.equal(existe.location, '/commande/livraison');
    const retour = await nav('/commande/livraison');
    assert.ok(retour.lu.includes('Mit dieser E-Mail-Adresse besteht bereits ein Konto.'), 'compte existant : message français');
    assert.match(retour.html, /href="\/compte\/connexion\?returnTo=%2Fcommande%2Flivraison" data-error-login>Jetzt anmelden/, 'compte existant : pas de lien de connexion');
  });

  await t.test('commande payée : la confirmation allemande dit ce qui a été encaissé', async () => {
    const nav = navigateur(base);
    await nav(ficheDe(upfront));
    await nav(`/panier/ajouter/${upfront._id}`, { method: 'POST', form: { qty: '1', returnTo: '/panier' } });
    await nav('/commande/livraison?guest=1');
    await nav('/commande/livraison', {
      method: 'POST',
      form: {
        shippingMethod: 'domicile', email: 'kaeufer-de@example.com', firstName: 'Max', lastName: 'Muster',
        phone: '+4930123456', line1: 'Hauptstraße 1', postalCode: '10115', city: 'Berlin', country: 'Allemagne',
      },
    });
    const paye = await nav('/commande/paiement', { method: 'POST', form: { paymentMethod: 'mollie', vehicleIdentifierType: 'vin', vehicleVin: 'WVWZZZ1KZAW000001', acceptCgv: 'true' } });
    assert.match(String(paye.location), /^\/compte\/commandes\/[0-9a-f]{24}$/, `paiement simulé : ${paye.status} ${paye.location}`);
    const idCommande = paye.location.split('/').pop();

    const enBase = await db.collection('orders').findOne({ _id: new mongoose.Types.ObjectId(idCommande) });
    assert.equal(enBase.lang, 'de');
    assert.equal(enBase.consigne.chargedTotalCents, 9900, 'jeu d’essai : consigne encaissée');

    const page = await nav(paye.location);
    assert.equal(langueHtml(page.html), 'de');
    assert.ok(page.lu.includes('Das Pfand von 99,00 € wurde bei der Bestellung berechnet.'), 'texte de la consigne encaissée absent');
    assert.ok(!page.lu.includes('Das Pfand wurde nicht berechnet'), 'la confirmation dit que la consigne n’a pas été encaissée');
    /* Totaux : les lignes s'additionnent jusqu'au total (articles 1 290 + port 99
       + Pfand 99 = 1 488), et la TVA porte sur le total MOINS le Pfand encaissé
       (1 389 → 231,50), comme la facture PDF. */
    const recap = recapitulatifCommande(page.html);
    assert.equal(recap.total, 148800, `total affiché : ${recap.texte}`);
    assert.equal(recap.sommeLignes, recap.total, `les lignes ne tombent pas sur le total : ${recap.texte}`);
    assert.ok(recap.texte.includes('Zwischensumme (Artikel) 1 290,00 €'), recap.texte);
    assert.ok(recap.texte.includes('Pfand (ohne MwSt.) 99,00 €'), 'ligne Pfand absente des totaux');
    assert.ok(recap.texte.includes('davon netto (ohne Pfand) 1 157,50 € MwSt. (20 %) 231,50 €'), `décomposition HT/TVA : ${recap.texte}`);
    assert.ok(!recap.texte.includes('Zwischensumme netto'), 'le port reste compté deux fois');
    /* Adresse, nom d'article, support. */
    assert.ok(page.lu.includes('10115 Berlin Deutschland'), 'pays en français');
    assert.ok(!page.lu.includes('Allemagne'), '« Allemagne » affiché');
    assert.ok(page.lu.includes('Rechnung Rechnungsadresse Max Muster'), 'libellé « Livraison » sous « Rechnung »');
    assert.ok(page.lu.includes(DQ200.localizations.de.name), 'nom d’article en français');
    assert.ok(!/href="\/sav"/.test(page.html), 'support vers /sav (page française)');
    assert.match(page.html, /href="\/de\/contact">\s*Kundenservice kontaktieren/);

    /* Expédiée en Autriche, échéance de retour dépassée. */
    const passe = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    await db.collection('orders').updateOne({ _id: enBase._id }, {
      $set: { status: 'shipped', 'shippingAddress.country': 'Autriche', 'shippingAddress.city': 'Wien', 'shippingAddress.postalCode': '1010', 'consigne.lines.0.dueAt': passe },
    });
    const expediee = await nav(paye.location);
    assert.ok(expediee.lu.includes('Ihre Bestellung ist unterwegs Zustellung in 4-6 Werktagen.'), 'délai du bandeau selon la langue, pas le pays');
    assert.ok(expediee.lu.includes('Rückgabefrist überschritten'));
    assert.ok(!expediee.lu.includes('Fälliger Pfandbetrag'), 'montant dû affiché pour une consigne déjà encaissée');
    assert.ok(!expediee.lu.includes('Überfällig'), 'retard « dû » affiché pour une consigne déjà encaissée');

    const liste = await nav('/compte/commandes');
    assert.ok(liste.lu.includes('Pfand • Rückgabefrist überschritten'), 'liste : ligne consigne en français ou montant dû');
    assert.match(liste.lu, /\b\d{2}\. [A-ZÄÖÜ][a-zäöü]+\.? \d{4}\b/, 'liste : date allemande sans le point du jour');

    const suivi = await nav(`${paye.location}/suivi`);
    assert.equal(langueHtml(suivi.html), 'de', 'suivi de commande en français');
    assert.ok(suivi.lu.includes('Bestellverlauf') && suivi.lu.includes('1010 Wien, Österreich'), 'suivi : textes ou pays en français');
    assert.ok(!suivi.lu.includes('Livraison estimée'));
    /* Livraison estimée : le délai de la ZONE, pas une date inventée. Le repli
       était createdAt + 3 jours calendaires — un dimanche, ou une date déjà
       passée — alors que le paiement promettait le délai du pays. */
    assert.ok(suivi.lu.includes('Voraussichtliche Zustellung Zustellung in 4-6 Werktagen'), `suivi : estimation « ${(suivi.lu.match(/Voraussichtliche Zustellung[^|]{0,60}/) || [])[0]} »`);
    assert.ok(!/Zwischen 08:00 und 18:00/.test(suivi.lu), 'créneau horaire inventé sur le suivi');
    assert.ok(!/\b(Sonntag|Samstag)\b/.test(suivi.lu), 'date de livraison un week-end');

    const compte = await nav('/compte');
    assert.equal(langueHtml(compte.html), 'de', 'tableau de bord en français');
    assert.ok(compte.lu.includes('Letzte Bestellungen') && compte.lu.includes('Versendet'));

    /* Page de compte restée française : le sélecteur montre la session allemande. */
    const profil = await nav('/compte/profil');
    assert.match(profil.html, /href="\/compte\/profil\?lang=fr" hreflang="fr"/, 'impossible de revenir au français depuis le profil');
    assert.match(profil.html, /href="\/compte\/profil" hreflang="de" aria-current="true">DE/);
  });

  await t.test('consigne conditionnelle : la page commande dit ce que le tunnel avait annoncé', async () => {
    const nav = navigateur(base);
    await nav(ficheDe(conditionnelle));
    await nav(`/panier/ajouter/${conditionnelle._id}`, { method: 'POST', form: { qty: '1', returnTo: '/panier' } });
    await nav('/commande/livraison?guest=1');
    await nav('/commande/livraison', {
      method: 'POST',
      form: {
        shippingMethod: 'domicile', email: 'pfand-de@example.com', firstName: 'Max', lastName: 'Muster',
        phone: '+4930123456', line1: 'Hauptstraße 1', postalCode: '10115', city: 'Berlin', country: 'Allemagne',
      },
    });
    const paye = await nav('/commande/paiement', { method: 'POST', form: { paymentMethod: 'mollie', vehicleIdentifierType: 'vin', vehicleVin: 'WVWZZZ1KZAW000002', acceptCgv: 'true' } });
    assert.match(String(paye.location), /^\/compte\/commandes\/[0-9a-f]{24}$/, `paiement simulé : ${paye.status} ${paye.location}`);

    const page = await nav(paye.location);
    assert.equal(langueHtml(page.html), 'de');
    /* La seule conséquence annoncée avant le bouton de commande est la
       FACTURATION du montant (« sonst berechnen wir 150,00 € »). La page
       d'après-paiement annonçait en plus la perte de la GARANTIE — une
       condition jamais montrée, et qui n'est la règle ni dans la FAQ ni dans
       l'e-mail de consigne. */
    assert.ok(page.lu.includes('Altteilrückgabe erforderlich'), 'titre du bloc Pfand absent');
    assert.ok(page.lu.includes('Trifft das Altteil nicht vor Fristende bei uns ein, berechnen wir den Betrag.'), `texte du bloc Pfand : « ${(page.lu.match(/Das Pfand wurde nicht berechnet[^|]{0,120}/) || [])[0]} »`);
    assert.ok(!/Garantie/.test(page.lu.slice(page.lu.indexOf('Pfand (Altteil)'), page.lu.indexOf('Pfand (Altteil)') + 900)), 'la page commande invoque encore la garantie');
    /* Le délai en jours, affiché partout ailleurs, manquait ici. */
    assert.ok(page.lu.includes('Frist beginnt nach der Zustellung (15 Tage)'), `délai absent : « ${(page.lu.match(/Frist beginnt[^|]{0,60}/) || [])[0]} »`);

    /* Échéance dépassée, consigne NON encaissée : le montant devient dû — sans
       parler de garantie. */
    const id = new mongoose.Types.ObjectId(paye.location.split('/').pop());
    await db.collection('orders').updateOne({ _id: id }, { $set: { 'consigne.lines.0.dueAt': new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    const enRetard = await nav(paye.location);
    assert.ok(enRetard.lu.includes('Überfällig (Betrag fällig)'), `statut en retard : « ${(enRetard.lu.match(/Überfällig[^|]{0,40}/) || [])[0]} »`);
    assert.ok(!enRetard.lu.includes('Garantie erloschen'), 'la garantie est encore annoncée comme perdue');
    assert.ok(enRetard.lu.includes('Fälliger Pfandbetrag: 150,00 €'), 'montant dû absent');

    /* Français : même règle, même texte. */
    const fr = await nav(`${paye.location}?lang=fr`);
    assert.ok(fr.lu.includes('Si l’ancienne pièce n’est pas reçue avant l’échéance, son montant vous sera facturé.'), `texte français : « ${(fr.lu.match(/La consigne n’est pas encaissée[^|]{0,120}/) || [])[0]} »`);
    assert.ok(fr.lu.includes('En retard (montant dû)'), 'statut français');
    assert.ok(!fr.lu.includes('garantie est annulée') && !fr.lu.includes('garantie annulée'), 'la version française invoque encore la garantie');
    assert.ok(fr.lu.includes('Échéance calculée après livraison (15 jours)') || fr.lu.includes('En retard (montant dû)'), 'délai français');
  });

  await t.test('inscription allemande : langue du compte et n° de TVA intracommunautaire', async () => {
    const nav = navigateur(base);
    await nav('/de/');
    const r = await nav('/compte/inscription', {
      method: 'POST',
      form: {
        accountType: 'pro', firstName: 'Max', lastName: 'Werkstatt', email: 'werkstatt-de@example.com', password: 'passwort-123',
        companyName: 'Werkstatt GmbH', siret: 'DE 123 456 789', acceptTerms: 'on', returnTo: '/compte',
      },
    });
    assert.equal(r.status, 302);
    const u = await db.collection('users').findOne({ email: 'werkstatt-de@example.com' });
    assert.equal(u.lang, 'de', 'e-mails du compte en français');
    assert.equal(u.vatNumberEu, 'DE123456789');
    /* La saisie reste dans `siret` : c'est le SEUL champ que la facture imprime,
       et /compte/profil l'exige pour un compte pro. C'est l'intitulé du PDF qui
       s'adapte — « N° TVA » au lieu de « SIRET ». */
    assert.equal(u.siret, 'DE 123 456 789', 'numéro d’entreprise perdu');
    assert.equal(intituleNumeroEntreprise(u.siret), 'N° TVA', 'n° de TVA imprimé comme SIRET');

    /* Un numéro de registre du commerce allemand n'est PAS un n° de TVA : le
       motif générique y voyait un préfixe croate (HR), vidait `siret` — le seul
       champ que la facture imprime — et le numéro disparaissait. */
    await nav('/compte/deconnexion', { method: 'POST' });
    await nav('/de/');
    await nav('/compte/inscription', {
      method: 'POST',
      form: {
        accountType: 'pro', firstName: 'Erik', lastName: 'Krause', email: 'krause-de@example.com', password: 'passwort-123',
        companyName: 'Krause GmbH', siret: 'HRB 123456', acceptTerms: 'on', returnTo: '/compte',
      },
    });
    const krause = await db.collection('users').findOne({ email: 'krause-de@example.com' });
    assert.equal(krause.siret, 'HRB 123456', 'numéro d’entreprise perdu');
    assert.equal(krause.vatNumberEu || '', '', 'HRB pris pour un n° de TVA croate');
    assert.equal(intituleNumeroEntreprise(krause.siret), 'SIRET', 'un HRB imprimé comme n° de TVA');

    /* Régression FRANÇAISE : un pro français qui tape son n° de TVA dans le
       champ « Numéro de SIRET » gardait un `siret` VIDE — plus aucun numéro sur
       la facture, et /compte/profil refusait toute modification (il exige
       société + SIRET pour un compte pro). */
    await nav('/compte/deconnexion', { method: 'POST' });
    await navigateur(base)('/produits');
    const navFr = navigateur(base);
    await navFr('/');
    await navFr('/compte/inscription', {
      method: 'POST',
      form: {
        accountType: 'pro', firstName: 'Jean', lastName: 'Dupont', email: 'pro-fr@example.com', password: 'motdepasse-123',
        companyName: 'Garage Dupont', siret: 'FR32123456789', acceptTerms: 'on', returnTo: '/compte',
      },
    });
    const proFr = await db.collection('users').findOne({ email: 'pro-fr@example.com' });
    assert.equal(proFr.siret, 'FR32123456789', 'numéro d’entreprise français perdu');
    assert.equal(proFr.vatNumberEu, 'FR32123456789');
    assert.equal(proFr.lang, 'fr');
    const profil = await navFr('/compte/profil');
    assert.match(profil.html, /name="siret"[^>]*value="FR32123456789"/, 'le profil réaffiche un SIRET vide');

    /* Lien de réinitialisation ouvert dans une session neuve (?lang=de). */
    const reset = await navigateur(base)('/compte/reinitialiser-mot-de-passe?token=inconnu&lang=de');
    assert.equal(langueHtml(reset.html), 'de');
    assert.ok(reset.lu.includes('Neues Passwort festlegen') && reset.lu.includes('Der Link ist abgelaufen oder ungültig.'));
  });

  await t.test('client français : textes et liens inchangés', async () => {
    const nav = navigateur(base);
    await nav(ficheFr(upfront));
    await nav(`/panier/ajouter/${conditionnelle._id}`, { method: 'POST', form: { qty: '1', returnTo: '/panier' } });
    await nav(`/panier/ajouter/${petitPrix._id}`, { method: 'POST', form: { qty: '1', opt_programmation: 'avec', returnTo: '/panier' } });
    const panier = await nav('/panier');
    assert.equal(langueHtml(panier.html), 'fr');
    assert.ok(panier.lu.includes('Retour de l’ancienne pièce obligatoire sous 15 jours après réception – sinon 150,00 € vous seront facturés'));
    /* Typographie française inchangée : espace avant les deux-points. */
    assert.ok(panier.lu.includes('Programmation : Avec programmation'), `résumé FR : « ${(panier.lu.match(/Programmation[^•]{0,40}/) || [])[0]} »`);

    /* Les libellés de l'autocomplétion de recherche sont exactement ceux qui
       étaient en dur dans public/js/search-autocomplete.js avant leur passage
       en i18n : le rendu français ne bouge pas d'un caractère. */
    const libellesFr = JSON.parse((panier.html.match(/window\.CPF_SEARCH_I18N = (\{.*?\});/) || [])[1]);
    assert.deepEqual(libellesFr, {
      ref: 'Réf:',
      product: 'Produit',
      vehicleMake: 'Marque véhicule',
      category: 'Catégorie',
      countResult: '%count% résultat',
      countResults: '%count% résultats',
      allResultsFor: 'Voir tous les résultats pour "%q%"',
    });

    const livraisonFr = await nav('/commande/livraison?guest=1');
    /* L'auto-complétion « code postal → ville » (API française) et le format à
       5 chiffres restent en place sur un formulaire français. */
    const champCpFr = (livraisonFr.html.match(/<input[^>]*id="postalCode"[^>]*>/) || [''])[0];
    assert.match(champCpFr, /maxlength="5"/, `maxlength perdu sur le code postal français : ${champCpFr}`);
    assert.match(livraisonFr.html, /geo\.api\.gouv\.fr\/communes/, 'auto-complétion du code postal retirée du tunnel français');

    await nav('/commande/livraison', {
      method: 'POST',
      form: {
        shippingMethod: 'domicile', email: 'client-fr@example.com', firstName: 'Jean', lastName: 'Dupont',
        phone: '0612345678', line1: '1 rue de Paris', postalCode: '75001', city: 'Paris', country: 'France',
      },
    });
    const paiementFr = await nav('/commande/paiement');
    /* Le total français s'aligne sur sa propre étape livraison (« Total TTC »)
       au lieu de « Total » nu ; la typographie française garde son espace. */
    assert.ok(paiementFr.lu.includes('Total TTC'), `total français : « ${(paiementFr.lu.match(/Total[^0-9]{0,12}/g) || []).join(' | ')} »`);
    assert.match(paiementFr.html, /Obligatoire<\/span> : nous vérifions/, `« Obligatoire » : ${(paiementFr.html.match(/Obligatoire<\/span>.{0,20}/) || [])[0]}`);

    await nav('/commande/paiement', { method: 'POST', form: { paymentMethod: 'mollie', vehicleIdentifierType: 'vin', vehicleVin: 'WVW', acceptCgv: 'true' } });
    assert.ok((await nav('/commande/paiement')).lu.includes('Erreur Le VIN semble trop court. Merci de vérifier.'));

    const paye = await nav('/commande/paiement', { method: 'POST', form: { paymentMethod: 'mollie', vehicleIdentifierType: 'plate', vehiclePlate: 'AB-123-CD', acceptCgv: 'true' } });
    assert.match(String(paye.location), /^\/compte\/commandes\//);
    await db.collection('orders').updateOne({ _id: new mongoose.Types.ObjectId(paye.location.split('/').pop()) }, { $set: { status: 'shipped' } });
    const page = await nav(paye.location);
    assert.equal(langueHtml(page.html), 'fr');
    assert.ok(page.lu.includes('Livraison prévue sous 2-3 jours ouvrés.'), 'bandeau français modifié');
    assert.ok(page.lu.includes('La consigne n’est pas encaissée.'));
    assert.ok(page.lu.includes('75001 Paris France'));
    assert.match(page.html, /href="\/sav">\s*Contacter le support/);
    assert.ok(!page.lu.includes('Consigne (hors TVA)'), 'ligne de consigne encaissée sur une commande sans encaissement');
    /* Le récapitulatif français tombe juste lui aussi (le port était compté deux fois). */
    const recapFr = recapitulatifCommande(page.html);
    assert.equal(recapFr.sommeLignes, recapFr.total, `lignes françaises ≠ total : ${recapFr.texte}`);
    assert.ok(recapFr.texte.includes('Sous-total articles') && recapFr.texte.includes('dont HT'), recapFr.texte);

    /* Suivi français : le délai de la métropole, pas une date inventée. */
    const suiviFr = await nav(`${paye.location}/suivi`);
    assert.ok(suiviFr.lu.includes('Livraison estimée Livré chez vous en 2-3 jours ouvrés'), `suivi FR : « ${(suiviFr.lu.match(/Livraison estimée[^|]{0,60}/) || [])[0]} »`);
  });
});
