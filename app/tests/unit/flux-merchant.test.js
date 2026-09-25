/**
 * Flux Google Merchant — règles d'exclusion et attributs (audit du 25/09/2026).
 *
 * Tests sans base : les règles vivent dans src/services/fluxMerchant.js et les
 * routes les appliquent dans construireArticles(), qu'on appelle ici avec des
 * fiches telles qu'elles sortent de la base (lean). Le port exact du panier est
 * vérifié contre la vraie base dans tests/integration/flux-merchant.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

/* brand.js lit l'environnement au chargement : la production tourne sous
   BRAND=autoliva (sinon sanitizeBrandLeak ne remplace rien). */
process.env.BRAND = 'autoliva';
delete process.env.SHOW_PRODUCT_DESCRIPTION;
delete process.env.SCALAPAY_ENABLED;

const flux = require('../../src/services/fluxMerchant');
const feedFr = require('../../src/routes/google-merchant-feed');
const feedDe = require('../../src/routes/google-merchant-feed-de');
const { MOTIF } = flux;
const { verifierXmlBienForme } = require('../fixtures/xml-bien-forme');

const hex = () => crypto.randomBytes(12).toString('hex');

/** Une fiche publiée conforme (boîte DEK de la production, simplifiée). */
function fiche(extra = {}) {
  return {
    _id: hex(),
    name: 'Boîte de vitesses reconditionnée Volkswagen Golf Caddy Touran 1.6 TDI — LZY',
    slug: 'boite-vitesses-volkswagen-golf-caddy-touran-1-6-tdi-lzy',
    sku: 'DEK-18078556779',
    category: 'Boîtes de vitesses',
    brand: 'Volkswagen',
    engineCode: 'LZY',
    priceCents: 114900,
    inStock: true,
    imageUrl: `/media/${hex()}`,
    galleryUrls: [],
    galleryTypes: [],
    badges: { condition: 'Reconditionnée · Échange standard', cards: [] },
    consigne: { enabled: true, amountCents: 30000, delayDays: 30, chargeUpfront: false },
    shippingDelayText: '24-72h',
    warranty: { months: 24, text: '' },
    compatibility: [{ make: 'Volkswagen', model: 'Golf Caddy Touran', engine: '1.6 TDI' }],
    compatibleReferences: [],
    specs: [{ label: 'Type', value: 'Manuelle' }],
    shortDescription: 'Boîte manuelle LZY pour Volkswagen Golf Caddy Touran 1.6 TDI en échange standard.',
    description: '<p>Boîte de vitesses manuelle LZY pour Volkswagen Golf Caddy Touran 1.6 TDI : reconditionnée en usine certifiée ISO 9001, puis testée sur banc.</p><p>Nos boîtes, qui équipent directement les concessionnaires, sont contrôlées avant expédition.</p>',
    ...extra,
  };
}

function construire(docs, options = {}) {
  return feedFr.construireArticles(docs, options);
}

/** Motif d'exclusion d'une fiche seule (null si gardée). */
function motif(doc, options) {
  const { bilan } = construire([doc], options);
  const m = Object.entries(bilan.exclus).find(([, n]) => n > 0);
  return m ? m[0] : null;
}

/* ─── Exclusions ───────────────────────────────────────────────────────────── */

test('exclusions : chaque règle a son motif', async (t) => {
  await t.test('une fiche conforme est gardée', () => {
    const { items, bilan } = construire([fiche()]);
    assert.equal(items.length, 1);
    assert.equal(bilan.articles, 1);
  });

  await t.test('SKU DM- : copie distrimotor', () => {
    assert.equal(motif(fiche({ sku: 'DM-81318' })), MOTIF.COPIE_DISTRIMOTOR);
    assert.equal(motif(fiche({ sku: 'dm-81318' })), MOTIF.COPIE_DISTRIMOTOR);
  });

  await t.test('service de clonage autonome : exclu', () => {
    assert.equal(motif(fiche({ serviceType: 'standalone_cloning', sku: 'CPF-SVC-CLONAGE' })), MOTIF.SERVICE_CLONAGE);
  });

  await t.test('image principale partagée par plus de 3 fiches publiées : exclue, jusqu’à 3 : gardée', () => {
    const photo = hex();
    const trois = [0, 1, 2].map((i) => fiche({ imageUrl: `/media/${photo}`, name: `Boîte de vitesses Audi A${i + 3} 2.0 TDI — KNS`, slug: `a${i}` }));
    assert.equal(construire(trois).items.length, 3, 'une même pièce déclinée en 3 fiches reste');
    /* La 4e l'utilise en GALERIE, sous son adresse SEO : c'est la même image. */
    const quatrieme = fiche({ galleryUrls: [`/media/boite-audi-${photo}.jpeg`], galleryTypes: ['image'], name: 'Boîte de vitesses Seat Leon 2.0 TDI — KNS', slug: 'a3' });
    const { items, bilan } = construire([...trois, quatrieme]);
    assert.equal(bilan.exclus[MOTIF.IMAGE_PARTAGEE], 3, 'les trois fiches dont c’est l’image principale');
    assert.deepEqual(items.map((i) => i.id), [quatrieme._id]);
  });

  await t.test('une vidéo de la galerie ne compte pas comme image', () => {
    const doc = fiche({ imageUrl: '', galleryUrls: ['/media/video-1'], galleryTypes: ['video'] });
    assert.equal(motif(doc), MOTIF.SANS_IMAGE);
  });

  await t.test('titre générique : ni véhicule ni référence', () => {
    const generique = { name: 'Turbo reconditionné – Garett – échange standard', slug: 'turbo-reconditionne-garett-echange-standard-7', sku: 'WC-1', category: 'Turbos', compatibility: [], compatibleReferences: ['80536744'], engineCode: '' };
    assert.equal(motif(fiche(generique)), MOTIF.TITRE_GENERIQUE);
    assert.equal(motif(fiche({ ...generique, name: 'Pompe à injection reconditionnée – échange standard', category: 'Pompe à injection' })), MOTIF.TITRE_GENERIQUE);
    /* Une marque, un modèle de la fiche ou une référence suffisent. */
    assert.equal(motif(fiche({ ...generique, name: 'Turbo reconditionné Audi A4 TDI – échange standard' })), null);
    assert.equal(motif(fiche({ ...generique, name: 'Turbo reconditionné 80536744 – échange standard' })), null);
    assert.equal(motif(fiche({ ...generique, name: 'Mécatronique DSG7 DQ200 reconditionnée', category: 'Mécatroniques & calculateurs' })), null);
    assert.equal(motif(fiche({ ...generique, name: 'Turbo reconditionné Golf – échange standard', compatibility: [{ make: '', model: 'Golf' }] })), null);
    /* Code moteur ou boîte en capitales, même sans code moteur renseigné… */
    assert.equal(motif(fiche({ ...generique, name: 'Boîte de vitesses manuelle TLE reconditionnée', category: 'Boîtes de vitesses' })), null);
    /* … mais ni un sigle courant, ni un titre écrit tout en capitales. */
    assert.equal(motif(fiche({ ...generique, name: 'Turbo reconditionné TDI – échange standard' })), MOTIF.TITRE_GENERIQUE);
    assert.equal(motif(fiche({ ...generique, name: 'TURBO RECONDITIONNÉ ÉCHANGE STANDARD' })), MOTIF.TITRE_GENERIQUE);
  });

  await t.test('titre porté par un autre article : les deux sortent, après les autres exclusions', () => {
    const a = fiche({ name: 'Boîte de vitesses reconditionnée Mercedes-Benz 2.2', slug: 'a' });
    const b = fiche({ name: 'boite de vitesses reconditionnee MERCEDES-BENZ 2.2', slug: 'b' });
    const { items, bilan } = construire([a, b]);
    assert.equal(items.length, 0);
    assert.equal(bilan.exclus[MOTIF.TITRE_DUPLIQUE], 2);
    /* Le doublon est une copie DM : exclue pour cela, la vraie fiche reste seule. */
    const { items: seul } = construire([a, { ...b, sku: 'DM-1' }]);
    assert.deepEqual(seul.map((i) => i.id), [a._id]);
  });

  await t.test('état impossible à établir : exclu (l’ancien flux supposait « reconditionné »)', () => {
    const muet = { badges: { condition: '' }, name: 'Boîte de vitesses Volkswagen Golf 1.6 TDI — LZY', slug: 'boite-vitesses-volkswagen-golf-lzy' };
    assert.equal(motif(fiche(muet)), MOTIF.ETAT_INDETERMINE);
    /* Titre qui dit deux états et aucun badge pour trancher. */
    assert.equal(motif(fiche({ ...muet, name: 'Moteur d’occasion reconditionné Renault 1.5 dCi K9K' })), MOTIF.ETAT_INDETERMINE);
    /* Un badge non reconnu laisse le titre décider. */
    assert.equal(motif(fiche({ ...muet, badges: { condition: 'Testé sur banc' }, name: 'Boîte de vitesses d’occasion Volkswagen Golf — LZY' })), null);
  });

  await t.test('neuf contredit par l’adresse, le titre ou la description : exclu', () => {
    const neuf = { badges: { condition: 'Neuf' }, name: 'Calculateur de boîte DSG DQ381 0GC927711 Neuf - Origine constructeur', slug: 'calculateur-dq381-neuf', description: '<p>Calculateur DQ381 d’origine.</p>', shortDescription: '' };
    assert.equal(motif(fiche(neuf)), null);
    assert.equal(motif(fiche({ ...neuf, description: '<p>Elle est proposée en échange standard, ce qui permet d’économiser.</p>' })), MOTIF.ETAT_CONTRADICTOIRE);
    assert.equal(motif(fiche({ ...neuf, slug: 'calculateur-dq381-reconditionne' })), MOTIF.ETAT_CONTRADICTOIRE);
    assert.equal(motif(fiche({ ...neuf, shortDescription: 'Pièce d’occasion contrôlée.' })), MOTIF.ETAT_CONTRADICTOIRE);
    /* Une mention NIÉE n'est pas une contradiction. */
    assert.equal(motif(fiche({ ...neuf, description: 'Contrairement à nos blocs en échange standard, ce produit est NEUF : aucune pièce d’occasion.' })), null);
    /* « notre partenaire reconditionneur », écrit par le filtre des allégations
       à la place de « notre atelier », désigne l'entreprise, pas l'état. */
    assert.equal(motif(fiche({ ...neuf, sku: 'ASY-0100113688', description: 'Moteur neuf, jamais monté. Chaque commande est contrôlée dans notre atelier avant expédition.' })), null);
  });

  await t.test('reconditionné ou occasion contredits par le titre : exclus', () => {
    assert.equal(motif(fiche({ badges: { condition: 'Reconditionné' }, name: 'Différentiel pont arrière neuf pour Nissan Qashqai', slug: 'differentiel-neuf-qashqai' })), MOTIF.ETAT_CONTRADICTOIRE);
    assert.equal(motif(fiche({ badges: { condition: 'Reconditionné' }, name: 'Moteur Renault 1.5 dCi K9K reconditionné à neuf', slug: 'moteur-k9k-reconditionne' })), null);
    assert.equal(motif(fiche({ badges: { condition: 'Occasion' }, name: 'Moteur Opel Zafira Z17DTR reconditionné', slug: 'moteur-z17dtr' })), MOTIF.ETAT_CONTRADICTOIRE);
    assert.equal(motif(fiche({ badges: { condition: 'Occasion' }, name: 'Moteur Opel Zafira Z17DTR — occasion', slug: 'moteur-z17dtr' })), null);
  });

  await t.test('consigne encaissée à la commande : exclue du flux français, pas de l’allemand', () => {
    const consigne = { consigne: { enabled: true, amountCents: 91000, delayDays: 30, chargeUpfront: true } };
    assert.equal(motif(fiche(consigne)), MOTIF.CONSIGNE_ENCAISSEE);
    /* Facturée seulement si l'ancienne pièce ne revient pas : rien à la commande. */
    assert.equal(motif(fiche({ consigne: { enabled: true, amountCents: 15000, chargeUpfront: false } })), null);
    assert.equal(motif(fiche({ consigne: { enabled: false, amountCents: 91000, chargeUpfront: true } })), null);
    assert.equal(motif(fiche({ consigne: { enabled: true, amountCents: 0, chargeUpfront: true } })), null);
    const de = fiche({ ...consigne, localizations: { de: { name: 'Getriebe generalüberholt Volkswagen Golf 1.6 TDI — LZY', slug: 'getriebe-lzy', translatedAt: new Date() } } });
    assert.equal(feedDe.construireArticles([de]).items.length, 1);
  });

  await t.test('hors stock : exclu (stock chiffré à 0 compris)', () => {
    assert.equal(motif(fiche({ inStock: false })), MOTIF.HORS_STOCK);
    assert.equal(motif(fiche({ stockQty: 0 })), MOTIF.HORS_STOCK);
    assert.equal(motif(fiche({ stockQty: 2, inStock: false })), null, 'la fiche lit le stock chiffré avant le drapeau');
  });

  await t.test('délai qui n’engage à rien : exclu', () => {
    for (const texte of ['Sur commande', 'Délai d’expédition sur demande', 'Délai selon disponibilité', 'délai confirmé à la commande',
      'Délai confirmé à la commande', 'Délai selon stock', 'Expédition sous 3 à 5 jours ouvrés selon stock']) {
      assert.equal(motif(fiche({ shippingDelayText: texte })), MOTIF.DELAI_NON_GARANTI, texte);
    }
    for (const texte of ['24-72h', '24 / 48h', '6-9 jours', 'Expédition sous 2 à 3 jours ouvrés', '']) {
      assert.equal(motif(fiche({ shippingDelayText: texte })), null, texte);
    }
  });

  await t.test('prix nul : exclu', () => {
    assert.equal(motif(fiche({ priceCents: 0 })), MOTIF.PRIX_INVALIDE);
  });

  await t.test('bilan : chaque fiche comptée une fois, sous son premier motif, puis une ligne de journal', () => {
    const docs = [
      fiche(),
      fiche({ sku: 'DM-1', inStock: false, name: 'Turbo reconditionné – échange standard' }),
      fiche({ inStock: false }),
      fiche({ shippingDelayText: 'Sur demande', consigne: { enabled: true, amountCents: 100, chargeUpfront: true } }),
    ];
    const { bilan } = construire(docs);
    assert.equal(bilan.fiches, 4);
    assert.equal(bilan.articles, 1);
    assert.equal(bilan.exclus[MOTIF.COPIE_DISTRIMOTOR], 1);
    assert.equal(bilan.exclus[MOTIF.HORS_STOCK], 1);
    assert.equal(bilan.exclus[MOTIF.DELAI_NON_GARANTI], 1);
    assert.equal(bilan.exclus[MOTIF.CONSIGNE_ENCAISSEE], 0);
    assert.equal(flux.resumerBilan('google-merchant-feed', bilan),
      '[google-merchant-feed] 1 articles sur 4 fiches publiées — exclus : copie_distrimotor 1, hors_stock 1, delai_non_garanti 1');
  });
});

test('le flux journalise UNE ligne par construction', async (t) => {
  const origine = { load: feedFr.loadProducts, tarifs: feedFr.chargerTarifs, journal: feedFr.journaliser };
  t.after(() => {
    feedFr.loadProducts = origine.load;
    feedFr.chargerTarifs = origine.tarifs;
    feedFr.journaliser = origine.journal;
    feedFr._invalidateCache();
  });
  const lignes = [];
  feedFr._invalidateCache();
  feedFr.loadProducts = async () => [fiche(), fiche({ sku: 'DM-2' })];
  feedFr.chargerTarifs = async () => null;
  feedFr.journaliser = (l) => lignes.push(l);
  const [a, b] = await Promise.all([feedFr.buildFeedCached(), feedFr.buildFeedCached()]);
  await feedFr.buildFeedCached();
  assert.equal(a, b);
  assert.deepEqual(lignes, ['[google-merchant-feed] 1 articles sur 2 fiches publiées — exclus : copie_distrimotor 1']);
});

test('base déconnectée : 503 + Retry-After, jamais un flux vide', async () => {
  feedFr._invalidateCache();
  await assert.rejects(feedFr.loadProducts(), (err) => err.code === flux.CODE_BASE_INDISPONIBLE);
  const reponse = { statut: 200, entetes: {}, corps: null };
  const res = {
    removeHeader() {},
    set(h, v) { if (typeof h === 'string') reponse.entetes[h] = v; else Object.assign(reponse.entetes, h); return res; },
    status(s) { reponse.statut = s; return res; },
    send(c) { reponse.corps = c; return res; },
  };
  await feedFr({}, res);
  assert.equal(reponse.statut, 503);
  assert.equal(reponse.entetes['Retry-After'], '120');
  await feedDe({}, res);
  assert.equal(reponse.statut, 503);
});

/* ─── Port, délais ─────────────────────────────────────────────────────────── */

test('port et délais : g:shipping France, préparation et transport des CGV art. 7.2', async (t) => {
  const tarifs = (cents, classe = null) => ({ portDomicileCents: () => cents, classeRetenue: () => classe });

  await t.test('le port vient des tarifs du panier, en France métropolitaine', () => {
    const [it] = construire([fiche()], { tarifs: tarifs(8900) }).items;
    assert.deepEqual(it.shipping, {
      country: 'FR',
      service: 'Livraison à domicile',
      price: '89.00 EUR',
      min_handling_time: 3,
      max_handling_time: 6,
      min_transit_time: 1,
      max_transit_time: 4,
    });
    assert.equal(it.min_handling_time, 3);
    assert.equal(it.max_handling_time, 6);
  });

  await t.test('pièces lourdes (moteur, boîte, pont, transfert) : 3–6 j ; standard : 1–3 j', () => {
    const cas = [
      ['Moteurs', 'Moteur Diesel K9K 1.5 dCi reconditionné – Renault', true],
      ['Boîtes de vitesses', 'Boîte de vitesses reconditionnée Peugeot 208 1.6 HDi — 20DP42', true],
      ['Ponts & différentiels', 'Pont arrière reconditionné BMW X5 E70 3.64', true],
      ['Boîtes de transfert', 'Boîte de transfert BMW ATC700 pour X5 E70', true],
      ['Mécatroniques & calculateurs', 'Mécatronique DSG7 DQ200 reconditionnée Volkswagen', false],
      ['Turbos', 'Turbo reconditionné Audi A4 2.0 TDI', false],
      ['Carrosserie / Éclairage > Phares / Feux', 'Phare avant LED BMW Série 5 G30 reconditionné', false],
    ];
    for (const [category, name, lourd] of cas) {
      const p = { category, name };
      assert.deepEqual(flux.delaisPreparation(p), lourd ? { min: 3, max: 6 } : { min: 1, max: 3 }, name);
      assert.deepEqual(flux.delaisTransport(p), lourd ? { min: 1, max: 4 } : { min: 1, max: 3 }, name);
    }
    /* Classe d'expédition « palette » : lourde, quelle que soit la catégorie. */
    assert.deepEqual(flux.delaisPreparation({ name: 'Accoudoir central Porsche', category: 'Habitacle > Consoles / Accoudoirs' }, { classe: { name: 'Palette' } }), { min: 3, max: 6 });
    /* Allemagne : 2 à 4 jours ouvrés après expédition. */
    assert.deepEqual(flux.delaisTransport({ category: 'Moteurs', name: 'Moteur' }, { pays: 'DE' }), { min: 2, max: 4 });
  });

  await t.test('un délai plus long écrit sur la fiche l’emporte, un plus court non', () => {
    const moteur = { category: 'Moteurs', name: 'Moteur Diesel YS23DDTT 2.3 reconditionné – Nissan' };
    assert.deepEqual(flux.delaisPreparation(moteur, { textes: ['6-9 jours'] }), { min: 6, max: 9 });
    assert.deepEqual(flux.delaisPreparation(moteur, { textes: ['3-5 jours'] }), { min: 3, max: 6 });
    const boite = { category: 'Boîtes de vitesses', name: 'Boîte de vitesses Volkswagen — LZY' };
    assert.deepEqual(flux.delaisPreparation(boite, { textes: ['24-72h'] }), { min: 3, max: 6 });
    const meca = { category: 'Mécatroniques & calculateurs', name: 'Mécatronique DSG7 DQ380 reconditionnée' };
    assert.deepEqual(flux.delaisPreparation(meca, { textes: ['24 / 48h'] }), { min: 1, max: 3 });
    assert.deepEqual(flux.delaisPreparation(meca, { textes: ['Expédition sous 2 à 3 jours ouvrés'] }), { min: 2, max: 3 });
  });

  await t.test('lecture des délais écrits sur les fiches', () => {
    const attendu = {
      '24 / 48h': { min: 1, max: 2 },
      '24-72h': { min: 1, max: 3 },
      '48h': { min: 1, max: 2 },
      '3-5 jours': { min: 3, max: 5 },
      'Expédition sous 3 à 5 jours': { min: 3, max: 5 },
      'Expédition sous 2 semaines': { min: 1, max: 10 },
      'Versand in 24-72 Std.': { min: 1, max: 3 },
      'Préparation et expédition sur palette après vérification': null,
      '': null,
    };
    for (const [texte, delai] of Object.entries(attendu)) assert.deepEqual(flux.delaiFicheEnJours(texte), delai, texte);
  });

  await t.test('flux allemand : pays DE, zone Europe, transport 2–4 j', () => {
    const doc = fiche({ localizations: { de: { name: 'Getriebe generalüberholt Volkswagen Golf 1.6 TDI — LZY', slug: 'getriebe-lzy', translatedAt: new Date() } } });
    const zones = [];
    const tarifsDe = { portDomicileCents: (p, zone) => { zones.push(zone); return 12900; }, classeRetenue: () => null };
    const [it] = feedDe.construireArticles([doc], { tarifs: tarifsDe }).items;
    assert.deepEqual(zones, ['europe']);
    assert.equal(it.shipping.country, 'DE');
    assert.equal(it.shipping.price, '129.00 EUR');
    assert.equal(it.shipping.service, 'Lieferung nach Hause');
    assert.deepEqual([it.shipping.min_transit_time, it.shipping.max_transit_time], [2, 4]);
    assert.equal(it.link, `https://autoliva.com/de/produits/getriebe-lzy-${doc._id}`);
  });
});

/* ─── Identifiants, marque, catégorie ──────────────────────────────────────── */

test('identifiants : MPN seulement s’il est fiable, sinon identifier_exists=no', async (t) => {
  await t.test('jamais le SKU interne, l’_id ni le code moteur', () => {
    const [it] = construire([fiche({ sku: 'ALV-BX-TWP-B7AB26', engineCode: 'TWP' })]).items;
    assert.equal(it.mpn, null);
    assert.equal(it.identifier_exists, 'no');
    const xml = feedFr.buildFeedXml([it]);
    assert.ok(!xml.includes('<g:mpn>'), 'aucune balise mpn');
    assert.ok(xml.includes('<g:identifier_exists>no</g:identifier_exists>'));
    assert.ok(!xml.includes('<g:gtin>'), 'jamais de GTIN inventé');
  });

  await t.test('référence fabricant en caractéristique : MPN, avec la marque', () => {
    const doc = fiche({ specs: [{ label: 'Référence fabricant', value: '0B5 325 025 A' }] });
    const [it] = construire([doc]).items;
    assert.equal(it.brand, 'Volkswagen');
    assert.equal(it.mpn, '0B5 325 025 A');
    assert.equal(it.identifier_exists, null);
    const xml = feedFr.buildFeedXml([it]);
    assert.ok(xml.includes('<g:mpn>0B5 325 025 A</g:mpn>') && !xml.includes('<g:identifier_exists>'));
  });

  await t.test('la seule référence compatible, citée par le titre : MPN', () => {
    const p = { name: 'Pont arrière reconditionné Audi A4 A5 B9 0DB500043', compatibleReferences: ['0DB500043'], specs: [] };
    assert.equal(flux.mpnFiable(p, 'Audi'), '0DB500043');
    assert.equal(flux.mpnFiable({ ...p, compatibleReferences: ['0DB500043', '0DB500043B'] }, 'Audi'), null, 'plusieurs références : laquelle ?');
    assert.equal(flux.mpnFiable({ ...p, name: 'Pont arrière reconditionné Audi A4' }, 'Audi'), null, 'le titre ne la cite pas');
    assert.equal(flux.mpnFiable(p, null), null, 'pas de MPN sans marque');
    /* Codes moteur ou boîte : pas des références de pièce. */
    assert.equal(flux.mpnFiable({ name: 'Moteur Opel Zafira Z17DTR-ZAFIRA — occasion', compatibleReferences: ['Z17DTR-ZAFIRA'] }, 'Opel'), null);
    assert.equal(flux.mpnFiable({ name: 'x', specs: [{ label: 'Référence', value: '0AM 325 025' }] }, 'Volkswagen'), null, '« Référence » seule = le SKU');
    assert.equal(flux.mpnFiable({ name: 'x', specs: [{ label: 'Réf. OEM', value: 'DM-81318' }] }, 'Opel'), null, 'SKU interne');
  });
});

test('marque : normalisée, jamais la boutique ni une valeur vide de sens', () => {
  const attendu = {
    AUDI: 'Audi', 'Renault / Nissan': 'Renault', 'Temic / VAG': 'Temic', Mercedes: 'Mercedes-Benz',
    'MERCEDES BENZ': 'Mercedes-Benz', Citroen: 'Citroën', VW: 'Volkswagen', 'Volkswagen Audi SEAT Skoda': 'Volkswagen',
    'Mitsubishi Montero': 'Mitsubishi', Porche: 'Porsche', LuK: 'LuK', BMW: 'BMW', Autoliva: null, Multimarque: null,
    Distrimotor: null, VAG: null, PSA: null, 'CarParts France': null, 'Volkswagen Audi Group': null,
    'Pièce d’origine reconditionnée': null, '': null,
  };
  for (const [brut, marque] of Object.entries(attendu)) {
    assert.equal(flux.marqueGoogle({ brand: brut, sku: 'WC-1' }), marque, brut);
  }
  /* Familles où la marque saisie est celle du véhicule, pas du fabricant. */
  assert.equal(flux.marqueGoogle({ brand: 'OPEL', sku: 'DM-81318' }), null);
  assert.equal(flux.marqueGoogle({ brand: 'Mercedes', sku: 'ALV-PT-2462800200' }), null);
  /* Sans marque sûre : pas de balise, jamais « Autoliva ». */
  const [it] = construire([fiche({ brand: 'Multimarque' })]).items;
  assert.equal(it.brand, null);
  assert.ok(!feedFr.buildFeedXml([it]).includes('<g:brand>'));
});

test('catégorie Google : la plus précise sûre, citée de la taxonomie officielle', () => {
  const attendu = {
    Moteurs: '8137', 'Boîtes de vitesses': '2641', 'Ponts & différentiels': '2641', 'Boîtes de transfert': '2641',
    'Transmission > Embrayage': '2641', Turbos: '2820', 'Culasses Diesel': '2820', 'Culasse Essence': '2820',
    'Pompe à injection': '2727', Injecteur: '2727', 'Carrosserie / Éclairage > Phares / Feux': '3318',
    'Démarreurs & alternateurs': '8231', 'Électricité / Électronique > Démarrage / Charge': '8231',
    'Freinage > Disques de frein': '2977', 'Habitacle > Consoles / Accoudoirs': '8233', 'Habitacle > Multimédia': '8526',
    'Mécatroniques & calculateurs': '899', 'Carrosserie / Éclairage > Pare-chocs': '8227', Autre: '5613', '': '5613',
  };
  for (const [category, id] of Object.entries(attendu)) {
    assert.equal(flux.categorieGoogle({ name: 'Pièce', category }), id, category);
  }
  /* La tête du nom corrige une fiche mal rangée ou une catégorie mixte. */
  assert.equal(flux.categorieGoogle({ name: 'Moteur Porsche Cayenne 955 Turbo 4.5 V8 d’occasion', category: 'Turbos' }), '8137');
  assert.equal(flux.categorieGoogle({ name: 'Mécatronique DSG7 DQ200 reconditionnée', category: 'Mécatroniques & calculateurs' }), '2641');
  assert.equal(flux.categorieGoogle({ name: 'Calculateur de boîte DSG DQ381', category: 'Mécatroniques & calculateurs' }), '2641');
  assert.equal(flux.categorieGoogle({ name: 'Calculateur d’aide au stationnement Porsche', category: 'Mécatroniques & calculateurs' }), '899');
  assert.equal(flux.categorieGoogle({ name: 'Mécatronique S tronic 0B5 DL501', category: 'Autre' }), '2641');
  assert.equal(flux.categorieGoogle({ name: 'Moteur d’essuie-glace avant', category: 'Autre' }), '5613');
});

/* ─── Textes ───────────────────────────────────────────────────────────────── */

test('titre et description : les filtres de la fiche, dans la langue servie', async (t) => {
  await t.test('description : allégations filtrées, ancien nom remplacé, texte brut', () => {
    const [it] = construire([fiche({ description: '<p>Chez Car Parts France, cette boîte est <strong>reconditionnée en usine certifiée ISO 9001</strong>.</p><ul><li>Testée sur banc</li><li>Qui équipent directement les concessionnaires</li></ul>' })]).items;
    assert.ok(!/ISO\s?9001/i.test(it.description), it.description);
    assert.ok(!/concessionnaires/i.test(it.description), it.description);
    assert.ok(!/car\s?parts\s?france/i.test(it.description), it.description);
    assert.ok(it.description.includes('Chez Autoliva, cette boîte est reconditionnée en usine spécialisée.'), it.description);
    assert.ok(!/<[a-z]/i.test(it.description), 'pas de HTML');
    assert.ok(it.description.includes('- Testée sur banc'));
  });

  await t.test('famille dont la description n’est jamais servie : aucun texte stocké', () => {
    /* DM est exclu du flux ; on vérifie la règle de description elle-même. */
    const dm = { sku: 'DM-81318', name: 'Turbo Garrett Opel 1.7 CDTI', description: 'Chez Car Parts France, nous vous proposons des turbos compresseur échange standard', shortDescription: 'Texte court copié', compatibility: [], compatibleReferences: ['80536744'] };
    const d = flux.descriptionDuFlux({ fiche: dm, description: dm.description, courte: dm.shortDescription, lang: 'fr', titre: dm.name, etat: 'refurbished' });
    assert.equal(d, 'Turbo Garrett Opel 1.7 CDTI. État : reconditionné. Références : 80536744.');
  });

  await t.test('interrupteur SHOW_PRODUCT_DESCRIPTION=off : la description courte, comme la meta de la fiche', () => {
    process.env.SHOW_PRODUCT_DESCRIPTION = 'off';
    try {
      const [it] = construire([fiche()]).items;
      assert.equal(it.description, 'Boîte manuelle LZY pour Volkswagen Golf Caddy Touran 1.6 TDI en échange standard.');
    } finally {
      delete process.env.SHOW_PRODUCT_DESCRIPTION;
    }
  });

  await t.test('flux allemand : jamais la description (la fiche /de ne la sert pas), la courte allemande sinon un texte factuel', () => {
    const base = fiche({ localizations: { de: { name: 'Getriebe generalüberholt Volkswagen Golf 1.6 TDI — LZY', slug: 'getriebe-lzy', translatedAt: new Date(), description: 'Lange maschinelle Übersetzung.', shortDescription: 'Schaltgetriebe LZY, in ISO 9001-zertifizierten Werken überholt. Generalüberholt und geprüft.' } } });
    const [it] = feedDe.construireArticles([base]).items;
    assert.equal(it.description, 'Generalüberholt und geprüft.');
    const sansCourte = fiche({ localizations: { de: { name: 'Getriebe generalüberholt Volkswagen Golf 1.6 TDI — LZY', slug: 'getriebe-lzy', translatedAt: new Date(), description: 'Lange Übersetzung.', shortDescription: '' } } });
    const [it2] = feedDe.construireArticles([sansCourte]).items;
    assert.equal(it2.description, 'Getriebe generalüberholt Volkswagen Golf 1.6 TDI — LZY. Zustand: generalüberholt. Passend für: Volkswagen Golf Caddy Touran. Referenzen: LZY.');
  });

  await t.test('titre : allégations et ancien nom filtrés, sans texte promotionnel, 150 caractères au plus', () => {
    const [it] = construire([fiche({ name: 'Boîte de transfert reconditionnée Audi Q7 3.6 FSI - 0AQ341010H - usine ISO 9001 - Garantie 2 ans - Car Parts France', warranty: { months: 12 } })]).items;
    assert.equal(it.title, 'Boîte de transfert reconditionnée Audi Q7 3.6 FSI - 0AQ341010H - Autoliva');
    const long = construire([fiche({ name: `Boîte de vitesses reconditionnée Volkswagen ${'Golf '.repeat(40)}— LZY` })]).items[0];
    assert.ok(long.title.length <= 150, `${long.title.length} caractères`);
  });
});

/* ─── Article complet et XML ───────────────────────────────────────────────── */

test('article : attributs requis, lien canonique, XML bien formé', async (t) => {
  const doc = fiche({
    name: 'Boîte <auto> & « manuelle » Volkswagen Golf — LZY ]]> \u0007',
    galleryUrls: ['/media/aaaaaaaaaaaaaaaaaaaaaaaa', '/media/aaaaaaaaaaaaaaaaaaaaaaaa'],
    galleryTypes: ['image', 'image'],
    description: 'Texte avec ]]> et un caractère de contrôle \u0001 à retirer. Reconditionnée en échange standard.',
  });
  const { items } = construire([doc]);
  const [it] = items;

  await t.test('les attributs Merchant requis sont présents', () => {
    for (const cle of ['id', 'title', 'description', 'link', 'image_link', 'availability', 'price', 'condition', 'google_product_category']) {
      assert.ok(it[cle], `${cle} manquant`);
    }
    assert.equal(it.link, 'https://autoliva.com/product/boite-vitesses-volkswagen-golf-caddy-touran-1-6-tdi-lzy/');
    assert.equal(it.price, '1149.00 EUR');
    assert.equal(it.availability, 'in_stock');
    assert.equal(it.condition, 'refurbished');
    assert.match(it.image_link, /^https:\/\/autoliva\.com\/media\/.+-[0-9a-f]{24}\.jpeg$/);
    assert.equal(it.additional_image_link.length, 1, 'image de galerie en double retirée');
    assert.ok(it.shipping && it.shipping.price);
  });

  await t.test('XML bien formé : échappements, CDATA, caractères interdits retirés', () => {
    const xml = feedFr.buildFeedXml(items);
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), 'caractère de contrôle dans le XML');
    assert.ok(xml.includes('Boîte &lt;auto&gt; &amp; « manuelle »'));
    assert.ok(xml.includes(']]]]><![CDATA[>'), 'le « ]]> » de la description est découpé');
    verifierXmlBienForme(xml);
  });
});
