/**
 * La fiche produit rendue par la VRAIE application — plan de reprise SEO du
 * 14/09/2026, action A3.
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production).
 *
 * ── Pourquoi un rendu complet ──────────────────────────────────────────────────
 *
 * La description des fiches revient après deux mois d'absence (faf510d). Elle
 * revient avec ce que les textes importés affirment sans preuve — « usine
 * certifiée ISO 9001 », « dans notre atelier », « 3× sans frais » alors que
 * Scalapay est coupé — et, pour 6 327 fiches, avec un texte copié mot pour mot
 * sur distrimotor.com. Un test sur le gabarit seul ne verrait rien de tout
 * cela : ces textes viennent de la base, passent par le contrôleur, le calque
 * allemand, le gabarit et ses partiels. On sert donc de VRAIES pages, par
 * l'application entière (app.js), à partir de 10 fiches copiées en lecture
 * seule depuis la production (tests/fixtures/fiches-produit-prod.json : champs
 * publics uniquement), une par famille d'import.
 *
 * Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions en mémoire),
 * serveur sur un port éphémère, base en mémoire détruite à la fin.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/* Configuration AVANT tout require de l'application : brand.js et app.js lisent
   l'environnement au chargement. La production tourne sous BRAND=autoliva. */
process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI; // sessions en mémoire, jamais de base externe
delete process.env.SCALAPAY_ENABLED; // coupé, comme en production depuis le 05/08
delete process.env.SHOW_PRODUCT_DESCRIPTION;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const FIXTURE = require('../fixtures/fiches-produit-prod.json');

let serveur;
let http;
let base;

const PAR_SKU = new Map(FIXTURE.produits.map((p) => [p.sku, p]));
const fiche = (prefixeSku) => FIXTURE.produits.find((p) => p.sku.startsWith(prefixeSku));
const DQ200 = PAR_SKU.get('0AM 325 025');
const DQ250 = fiche('02E927770AD');
const ASY = fiche('ASY-');
const DEK = fiche('DEK-');
const ALVBX = fiche('ALV-BX-');
const EDN = fiche('EDN-');
const AUTO = fiche('AUTO-');
const WC = fiche('WC-');
const DM = fiche('DM-');
const ALIBABA = fiche('ALV-PT-');

/* ─── Outils de lecture de la page ─────────────────────────────────────────── */

function decoder(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Texte lisible d'un morceau de HTML : sans scripts, styles ni balises. */
function texte(html) {
  return decoder(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionDescription(html) {
  const debut = html.indexOf('<section id="description"');
  if (debut < 0) return null;
  return html.slice(debut, html.indexOf('</section>', debut));
}

/* Bloc « Véhicules compatibles », jusqu'au titre « Caractéristiques » (où
   les références de la pièce, elles, ont leur place). */
function sectionCompat(html) {
  const debut = html.indexOf('<div id="compat">');
  if (debut < 0) return null;
  return html.slice(debut, html.indexOf('>Caractéristiques<', debut));
}

function metaDescription(html) {
  const m = html.match(/<meta name="description" content="([^"]*)"/);
  return m ? decoder(m[1]) : '';
}

function jsonLd(html) {
  const blocs = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const graphe = [];
  for (const b of blocs) {
    const d = JSON.parse(b[1]);
    if (Array.isArray(d['@graph'])) graphe.push(...d['@graph']); else graphe.push(d);
  }
  return graphe;
}

/** Tout ce que la page AFFIRME à un visiteur ou à Google : texte visible,
    meta, og, JSON-LD. Les scripts et styles n'en font pas partie. */
function toutCeQuiEstAffirme(html) {
  const ld = jsonLd(html).map((n) => JSON.stringify(n)).join(' ');
  const og = [...html.matchAll(/<meta property="og:[a-z]+" content="([^"]*)"/g)].map((m) => decoder(m[1])).join(' ');
  return `${texte(html)} ${metaDescription(html)} ${og} ${ld}`;
}

async function get(chemin) {
  const r = await fetch(base + chemin, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), html: await r.text() };
}

async function getFiche(p) {
  const r = await get(`/product/${encodeURIComponent(p.slug)}/`);
  assert.equal(r.status, 200, `${p.sku} : la fiche doit répondre 200 (reçu ${r.status} → ${r.location || ''})`);
  return r.html;
}

/* Premières phrases d'un texte de fiche, pour savoir s'il est dans la page. */
function extrait(s, n = 70) {
  return texte(s).slice(0, n);
}

/* Durées de garantie annoncées : « garanti(e)… N mois / N an(s) » à moins de
   45 caractères du mot « garanti ». Volontairement indépendant du filtre. */
const NOMBRES = { un: 1, une: 1, deux: 2, trois: 3, six: 6, douze: 12 };
function dureesDeGarantie(s) {
  const t = String(s || '');
  const mots = [...t.matchAll(/garanti/gi)].map((m) => m.index);
  const out = [];
  for (const m of t.matchAll(/\b(\d{1,3}|une?|deux|trois|six|douze)\s*(mois|ans?|années?)(?![a-zà-ÿ])/gi)) {
    if (!mots.some((i) => Math.abs(i - m.index) <= 45)) continue;
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NOMBRES[m[1].toLowerCase()];
    out.push(/^mois$/i.test(m[2]) ? n : n * 12);
  }
  return out;
}

const ALLEGATIONS = {
  'ISO 9001': /ISO\s?-?\s?9001/i,
  'atelier / usine « à nous »': /\b(?:nos ateliers|notre atelier|notre usine|nos usines)\b/i,
  'fournisseur des concessionnaires': /fournisseurs? des concessionnaires|équipent directement les concessionnaires/i,
  'couverture la plus longue': /couverture la plus longue/i,
  '3x / 4x sans frais': /\b[34]\s?[x×]\s*(?:ou\s+[34]\s?[x×]\s*)?(?:sans\s+frais|\()|\b[34]\s?[x×]\s*\/\s*[34]\s?[x×](?![0-9])|\bpaiements?\s+(?:en\s+)?[34]\s?[x×](?![0-9a-z])|\bscalapay\b|\b[34]\s+fois\s+sans\s+frais/i,
};

/* ─── Base en mémoire + application ────────────────────────────────────────── */

function versMongo(p) {
  const doc = { ...p };
  delete doc._role;
  doc._id = new mongoose.Types.ObjectId(p._id);
  if (doc.localizations && doc.localizations.de) {
    doc.localizations = { de: { ...doc.localizations.de } };
    if (doc.localizations.de.translatedAt) doc.localizations.de.translatedAt = new Date(doc.localizations.de.translatedAt);
  }
  return doc;
}

function slugifier(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

test('fiche produit rendue par l’application — description et allégations (plan SEO A3)', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  await db.collection('products').insertMany(FIXTURE.produits.map(versMongo));
  const categories = [...new Set(FIXTURE.produits.map((p) => p.category))];
  await db.collection('categories').insertMany(categories.map((name) => ({ name, slug: slugifier(name), isActive: true })));

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    delete process.env.SHOW_PRODUCT_DESCRIPTION;
    delete process.env.SCALAPAY_ENABLED;
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  /* Les pages sont servies une fois, puis relues par chaque assertion. */
  const pages = new Map();
  for (const p of FIXTURE.produits) pages.set(p.sku, await getFiche(p));

  await t.test('(f) données structurées fidèles aux CGV et à la page (audit du 25/09/2026)', () => {
    for (const p of FIXTURE.produits) {
      const html = pages.get(p.sku);
      const brut = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('');
      assert.ok(!/[<>]/.test(brut), `${p.sku} : « < » ou « > » non échappé dans le JSON-LD`);
      assert.ok(!/FreeReturn|"merchantReturnDays":30/.test(brut), `${p.sku} : retour gratuit sous 30 jours annoncé (CGV : 14 jours, frais au client)`);
      const produit = jsonLd(html).find((n) => n['@type'] === 'Product');
      assert.ok(produit, `${p.sku} : pas de Product`);
      assert.equal(produit.hasMerchantReturnPolicy, undefined, `${p.sku} : politique de retour sur la fiche`);
      assert.equal(produit.manufacturer, undefined, `${p.sku} : Autoliva déclaré fabricant`);
      const proprietes = (produit.additionalProperty || []).map((x) => `${x.name}: ${x.value}`).join(' | ');
      assert.ok(!/Test qualité: Testé sur banc/.test(proprietes), `${p.sku} : « Testé sur banc » ajouté d'office`);
      const offre = produit.offers || {};
      assert.ok(offre.seller && offre.seller['@id'] && offre.seller['@id'].endsWith('/#organization'), `${p.sku} : vendeur sans lien vers l'organisation`);
      const port = offre.shippingDetails;
      assert.ok(port, `${p.sku} : port absent du JSON-LD`);
      assert.equal(port.shippingDestination.addressCountry, 'FR');
      assert.ok(!('deliveryTime' in port), `${p.sku} : délai de livraison inventé`);
      if (p.serviceType === 'standalone_cloning') assert.equal(port.shippingRate.value, '0.00');
      else assert.notEqual(port.shippingRate.value, '0.00', `${p.sku} : port gratuit annoncé alors que le panier le facture`);
      if (produit.mpn) assert.match(produit.mpn, /\d/, `${p.sku} : MPN sans chiffre (code moteur ?)`);
      if (offre.warranty) {
        const d = offre.warranty.durationOfWarranty;
        if (Number(p.warranty && p.warranty.months) > 0) {
          assert.deepEqual([d.value, d.unitCode], [Number(p.warranty.months), 'MON'], `${p.sku} : garantie différente de celle affichée`);
        }
      }
    }
  });

  await t.test('slug à double tiret (75 fiches Dekram) : la fiche répond, pas la recherche', async () => {
    const id = new mongoose.Types.ObjectId();
    const slug = 'boite-vitesses-ford-kuga-2-0--19060';
    await db.collection('products').insertOne(versMongo({ ...DEK, _id: id.toHexString(), sku: 'DEK-11295319060', slug }));
    try {
      const r = await get(`/product/${slug}/`);
      assert.equal(r.status, 200, `double tiret : ${r.status} → ${r.location || ''}`);
      assert.match(r.html, new RegExp(`<link rel="canonical" href="[^"]*/product/${slug}/"`), 'canonique vers le slug exact');
    } finally {
      await db.collection('products').deleteOne({ _id: id });
    }
  });

  await t.test('(a)(b)(c) la description est dans la page pour les fiches françaises autorisées', () => {
    const attendus = [
      [DQ200, 'La mécatronique est l’organe électro-hydraulique qui pilote la boîte DSG7 DQ200'],
      [DQ250, 'Mécatronique DSG6 DQ250 reconditionnée en échange standard, livrée complète'],
      [ASY, 'est un diesel 2.3 16v reconditionné chez notre partenaire reconditionneur'],
      [DEK, 'reconditionnée dans des usines spécialisées. Parfaite pour corriger un point dur'],
      [ALVBX, 'est reconditionnée en usine spécialisée, puis testée sur banc avant expédition'],
      [EDN, 'reconditionnée en usine spécialisée et contrôlée sur banc'],
      [AUTO, 'moteur complet d\'occasion — 1.7 L · 125 ch · Diesel pour remplacement'],
      [WC, 'Cette boîte de transfert Mercedes-Benz 4MATIC pour transmission 7G-Tronic 722.9'],
    ];
    for (const [p, phrase] of attendus) {
      const section = sectionDescription(pages.get(p.sku));
      assert.ok(section, `${p.sku} : pas de bloc description`);
      assert.ok(texte(section).includes(phrase), `${p.sku} : la description attendue manque — « ${phrase} »`);
    }
    /* La plus vue : ses ~440 mots, pas un résumé. */
    const mots = texte(sectionDescription(pages.get(DQ200.sku))).split(/\s+/).length;
    assert.ok(mots > 400, `DQ200 : ${mots} mots seulement dans le bloc description`);
  });

  await t.test('(b) copie distrimotor (DM-) : aucune trace de son texte, ni dans la page ni dans la meta', () => {
    const html = pages.get(DM.sku);
    assert.equal(sectionDescription(html), null, 'le bloc description ne doit pas exister sur une fiche DM');
    const tout = toutCeQuiEstAffirme(html);
    assert.ok(!tout.includes(extrait(DM.description.replace(/^Chez Car Parts France, /, ''), 60)), 'le texte copié ressort');
    assert.ok(!/distrimotor/i.test(html), 'distrimotor apparaît dans la page');
    assert.ok(!/Turbos garantis 1 an Chaque turbo/.test(tout), 'le corps du texte copié ressort');
  });

  await t.test('(c) Alibaba (ALV-PT/BT/MEC/CP/RD) : description servie depuis la décision 4', () => {
    /* Retenue du 14 au 16/09/2026, le temps que Killian confirme l'état réel :
       ces pièces sont refaites en usine, donc le texte qui décrit le démontage,
       la remise en état et le contrôle avant envoi dit vrai. Les autres règles
       continuent de s'y appliquer. */
    const html = pages.get(ALIBABA.sku);
    const section = sectionDescription(html);
    assert.ok(section, 'le bloc description manque sur la fiche Alibaba');
    assert.ok(texte(section).includes(extrait(ALIBABA.description, 60)), 'la description Alibaba ne ressort pas');
    const tout = toutCeQuiEstAffirme(html);
    assert.ok(!ALLEGATIONS['atelier / usine « à nous »'].test(tout), 'atelier « à nous » sur une fiche Alibaba');
    /* ISO 9001 : Killian détient le certificat de l'usine qui refait ces
       pièces — la mention revient, accordée aux partenaires. */
    const lisible = texte(html);
    assert.ok(lisible.includes('Qualité Premium : ISO 9001'), 'le badge ISO 9001 doit revenir sur la fiche Alibaba');
    assert.ok(lisible.includes('chez nos partenaires reconditionneurs certifiés ISO 9001'), 'la mention ISO du gabarit, accordée aux partenaires');
    assert.ok(!/reconditionneurs certifiées/.test(lisible), 'faute d’accord');
  });

  await t.test('(a) en allemand : jamais de description, même traduite', async () => {
    const de = DQ200.localizations.de;
    const r = await get(`/de/produits/${encodeURIComponent(de.slug)}-${DQ200._id}`);
    assert.equal(r.status, 200, `fiche allemande : ${r.status} ${r.location || ''}`);
    assert.equal(sectionDescription(r.html), null, 'bloc description servi sous /de');
    assert.ok(!texte(r.html).includes(extrait(de.description, 60)), 'la traduction automatique ressort sous /de');
    assert.ok(texte(r.html).includes(de.name.slice(0, 30)), 'la page allemande doit rester servie (nom traduit)');

    /* Et l'ISO 9001 n'y ressort pas non plus : badge, meta, gabarit allemand. */
    const rDek = await get(`/de/produits/${encodeURIComponent(DEK.localizations.de.slug)}-${DEK._id}`);
    assert.equal(rDek.status, 200);
    assert.ok(!ALLEGATIONS['ISO 9001'].test(toutCeQuiEstAffirme(rDek.html)), 'ISO 9001 sur la fiche allemande');
    /* Ni l'atelier « à nous » du gabarit allemand (« Von unseren Werkstätten
       aus », sous la photo de chargement) : la légende reste, réécrite. */
    const deTexte = texte(rDek.html);
    assert.ok(!/unseren Werkstätten|unserer Werkstatt\b/.test(deTexte), 'atelier « à nous » sur la fiche allemande');
    assert.ok(deTexte.includes('Von unseren Partnerwerkstätten aus'), 'la légende de la photo doit rester, réécrite');
  });

  await t.test('(e) aucune allégation non prouvée sur les 10 fiches — texte, meta, JSON-LD', () => {
    for (const p of FIXTURE.produits) {
      const tout = toutCeQuiEstAffirme(pages.get(p.sku));
      for (const [nom, rx] of Object.entries(ALLEGATIONS)) {
        /* ISO 9001 prouvé pour les seules fiches Alibaba (certificat détenu). */
        if (nom === 'ISO 9001' && p.sku.startsWith('ALV-PT-')) continue;
        const m = tout.match(rx);
        assert.ok(!m, `${p.sku} : « ${nom} » affiché — …${m ? tout.slice(Math.max(0, m.index - 60), m.index + 60) : ''}…`);
      }
      assert.ok(!/car\s?parts\s?france/i.test(sectionDescription(pages.get(p.sku)) || ''), `${p.sku} : ancien nom dans la description`);
      assert.ok(!/car\s?parts\s?france/i.test(metaDescription(pages.get(p.sku))), `${p.sku} : ancien nom dans la meta`);
      const produitLd = jsonLd(pages.get(p.sku)).find((n) => n['@type'] === 'Product');
      assert.ok(produitLd && !/car\s?parts\s?france/i.test(produitLd.description || ''), `${p.sku} : ancien nom dans le JSON-LD`);
    }
  });

  await t.test('(e) les réécritures gardent l’information vraie', () => {
    /* La boîte reste « reconditionnée en usine », le moteur « chez notre
       partenaire », la FAQ de garantie répond toujours. */
    assert.match(texte(pages.get(DEK.sku)), /usines spécialisées/);
    assert.match(texte(pages.get(ASY.sku)), /contrôlée avant expédition par notre partenaire reconditionneur/);
    assert.match(texte(pages.get(EDN.sku)), /Cette boîte reconstruite à zéro kilomètre et testée sur banc est garantie 2 ans/);
    /* La FAQ « Puis-je payer en plusieurs fois ? » disparaît de la page ET du
       JSON-LD FAQPage ; les autres questions restent. */
    assert.match(texte(pages.get(AUTO.sku)), /Quelle garantie sur ce moteur \?/);
    assert.ok(!/Puis-je payer en plusieurs fois/.test(texte(pages.get(AUTO.sku))), 'FAQ paiement fractionné affichée');
    const faq = jsonLd(pages.get(AUTO.sku)).find((n) => n['@type'] === 'FAQPage');
    assert.ok(faq, 'la FAQ de la fiche doit rester');
    assert.ok(!faq.mainEntity.some((q) => /plusieurs fois/.test(q.name)), 'FAQ paiement fractionné encore là');
    /* Meta WC : la proposition « paiement en 3× » tombe, le reste de la phrase reste. */
    assert.equal(metaDescription(pages.get(WC.sku)), 'Boîte de transfert Mercedes. Reconditionnée 1 490 € TTC, garantie 2 ans, livraison 48-72 h. Échange standard sans caution.');
  });

  await t.test('(d) les points clés restent masqués', () => {
    const tout = toutCeQuiEstAffirme(pages.get(DEK.sku));
    for (const kp of DEK.keyPoints.filter((k) => /ISO|concessionnaires|zéro kilomètre —/.test(k))) {
      assert.ok(!tout.includes(kp), `point clé affiché : ${kp}`);
    }
    assert.ok(!toutCeQuiEstAffirme(pages.get(WC.sku)).includes('Équipe technique dédiée Mercedes-Benz'), 'point clé WC affiché');
  });

  await t.test('(e) garantie : aucune durée ne contredit warranty.months', () => {
    for (const p of FIXTURE.produits) {
      const mois = p.warranty && Number(p.warranty.months) > 0 ? Number(p.warranty.months) : 0;
      if (!mois) continue;
      const html = pages.get(p.sku);
      const produitLd = jsonLd(html).find((n) => n['@type'] === 'Product') || {};
      const faq = jsonLd(html).find((n) => n['@type'] === 'FAQPage');
      const sources = [
        texte(sectionDescription(html) || ''),
        metaDescription(html),
        produitLd.description || '',
        faq ? faq.mainEntity.map((q) => q.acceptedAnswer.text).join(' ') : '',
      ].join(' \n ');
      for (const d of dureesDeGarantie(sources)) {
        assert.equal(d, mois, `${p.sku} : garantie annoncée ${d} mois, fiche à ${mois} mois`);
      }
    }
  });

  await t.test('(e) une garantie qui contredit la fiche est retirée du rendu', async () => {
    /* Même moteur, garantie ramenée à 6 mois en admin — le texte dit toujours
       « Garanti 12 mois ». La page ne doit plus le dire. */
    const copie = versMongo({ ...ASY, _id: new mongoose.Types.ObjectId().toHexString(), slug: `${ASY.slug}-garantie-6`, warranty: { months: 6, text: '' } });
    await db.collection('products').insertOne(copie);
    const r = await get(`/product/${copie.slug}/`);
    assert.equal(r.status, 200);
    const section = texte(sectionDescription(r.html));
    assert.ok(section.includes('est un diesel 2.3 16v'), 'le reste de la description doit rester');
    assert.ok(!/Garanti 12 mois/.test(section), '« Garanti 12 mois » affiché sur une fiche à 6 mois');
    await db.collection('products').deleteOne({ _id: copie._id });
  });

  await t.test('(f) SHOW_PRODUCT_DESCRIPTION=off coupe le bloc partout', async () => {
    process.env.SHOW_PRODUCT_DESCRIPTION = 'off';
    try {
      const html = await getFiche(DQ200);
      assert.equal(sectionDescription(html), null);
      assert.ok(!texte(html).includes('La mécatronique est l’organe électro-hydraulique'));
    } finally {
      delete process.env.SHOW_PRODUCT_DESCRIPTION;
    }
    assert.ok(sectionDescription(await getFiche(DQ200)), 'le bloc revient sans la variable');
  });

  await t.test('blocs « fin de description » : filtrés, et jamais sans la description', async () => {
    /* faf510d remet ces blocs à l'écran avec la description. Un bloc est
       partagé par des centaines de fiches : sa garantie et son « nos ateliers »
       doivent passer par le même filtre que la fiche. Et là où la description
       est retenue (DM, interrupteur), la section entière reste absente — le
       retour arrière « off » rend la page d'avant, sans titre orphelin. */
    const blocId = new mongoose.Types.ObjectId();
    await db.collection('infoblocks').insertOne({
      _id: blocId,
      title: 'Conditions — Boîtes reconditionnées',
      slug: 'conditions-test-a3',
      content: 'Chaque boîte est contrôlée dans nos ateliers avant expédition.\n\nGarantie : 1 an pièces et main d’œuvre.',
      position: 'description_end',
      isActive: true,
      autoCategories: [],
      sortOrder: 0,
    });
    const dek = { ...versMongo({ ...DEK, _id: new mongoose.Types.ObjectId().toHexString(), slug: `${DEK.slug}-bloc` }), infoBlockIds: [blocId] };
    const dm = { ...versMongo({ ...DM, _id: new mongoose.Types.ObjectId().toHexString(), slug: `${DM.slug}-bloc` }), infoBlockIds: [blocId] };
    await db.collection('products').insertMany([dek, dm]);
    try {
      const section = sectionDescription((await get(`/product/${dek.slug}/`)).html);
      assert.ok(section, 'DEK : la section description doit exister');
      const bloc = texte(section);
      assert.ok(bloc.includes('Conditions — Boîtes reconditionnées'), 'le bloc doit être rendu');
      assert.ok(bloc.includes('Chaque boîte est contrôlée chez nos partenaires reconditionneurs avant expédition.'), 'le bloc doit être réécrit');
      assert.ok(!/nos ateliers/.test(bloc), '« nos ateliers » dans le bloc');
      assert.ok(!/1 an pièces/.test(bloc), 'garantie 1 an affichée sur une fiche à 24 mois');

      const rDm = await get(`/product/${dm.slug}/`);
      assert.equal(rDm.status, 200);
      assert.equal(sectionDescription(rDm.html), null, 'DM : section description rendue pour un seul bloc');

      process.env.SHOW_PRODUCT_DESCRIPTION = 'off';
      try {
        const rOff = await get(`/product/${dek.slug}/`);
        assert.equal(sectionDescription(rOff.html), null, 'off : la section doit disparaître, blocs compris');
        assert.ok(!texte(rOff.html).includes('Conditions — Boîtes reconditionnées'), 'off : le bloc reste affiché');
      } finally {
        delete process.env.SHOW_PRODUCT_DESCRIPTION;
      }
    } finally {
      await db.collection('products').deleteMany({ _id: { $in: [dek._id, dm._id] } });
      await db.collection('infoblocks').deleteOne({ _id: blocId });
    }
  });

  await t.test('le filtre 3x/4x suit Scalapay : rallumé, la mention revient', async () => {
    process.env.SCALAPAY_ENABLED = 'on';
    try {
      const html = await getFiche(AUTO);
      assert.match(texte(html), /Puis-je payer en plusieurs fois \?/);
      assert.match(texte(html), /le paiement en 3× ou 4× sans frais est disponible/);
    } finally {
      delete process.env.SCALAPAY_ENABLED;
    }
  });

  await t.test('(e) page véhicule : les textes rédigés en base passent par le filtre', async () => {
    /* Aucune des 724 pages n'est servie aujourd'hui (catégories inactives ou
       absentes) : on simule la réactivation que redoute le plan. */
    const vl = FIXTURE.vehicleLandings[0];
    await db.collection('categories').insertOne({ name: 'Transmission > Mécatronique', slug: vl.partType, isActive: true });
    await db.collection('vehiclelandings').insertOne({ ...vl, _id: new mongoose.Types.ObjectId(vl._id) });
    await db.collection('products').insertOne(versMongo({ ...DQ200, _id: new mongoose.Types.ObjectId().toHexString(), slug: `${DQ200.slug}-landing`, category: 'Transmission > Mécatronique' }));
    require('../../src/services/vehicleLandingService').clearCache();

    const r = await get(`/pieces-auto/${vl.make}/${vl.model}/${vl.partType}`);
    assert.equal(r.status, 200, `page véhicule : ${r.status} ${r.location || ''}`);
    const tout = toutCeQuiEstAffirme(r.html);
    assert.ok(tout.includes('testée sur banc chez nos partenaires reconditionneurs avant expédition'), 'le texte rédigé doit être servi, réécrit');
    assert.ok(tout.includes('Échange standard avec consigne de 30 jours'), 'la phrase vraie reste');
    for (const nom of ['atelier / usine « à nous »', '3x / 4x sans frais', 'ISO 9001']) {
      assert.ok(!ALLEGATIONS[nom].test(tout), `page véhicule : « ${nom} » affiché`);
    }
    assert.ok(!/garantie de 24 mois/.test(tout), 'garantie « en bloc » affichée');
    assert.equal(metaDescription(r.html), 'Mécatronique Audi A1 reconditionnée (1.0 TSI, 1.2 TFSI) · 1 référence testée(s) sur banc · livraison 24-48h.');
  });

  await t.test('comparatif et véhicules compatibles : rien de faux, rien d’interne (audit du 25/09/2026)', async () => {
    /* Colonne « Occasion » : la garantie légale de conformité et celle des
       vices cachés s'appliquent aussi à l'occasion (CGV art. 11) ; « Aucune »
       et « Aucun recours » étaient faux. Le sous-titre parlait d'une « boîte
       de vitesses » sur une boîte de transfert, un pont, une mécatronique. */
    for (const p of [DQ200, WC, ALIBABA]) {
      const lisible = texte(pages.get(p.sku));
      assert.ok(lisible.includes('Occasion, reconditionné ou neuf ?'), `${p.sku} : le comparatif doit rester`);
      assert.ok(lisible.includes('Garantie légale seulement'), `${p.sku} : garantie de l’occasion`);
      assert.ok(lisible.includes('Recours limités'), `${p.sku} : recours de l’occasion`);
      assert.ok(!/Garantie Aucune\b|Aucun recours/.test(lisible), `${p.sku} : « Aucune » / « Aucun recours » affiché`);
      assert.ok(lisible.includes('comparés honnêtement — pour cette pièce.'), `${p.sku} : sous-titre générique`);
      assert.ok(!lisible.includes('pour cette boîte de vitesses'), `${p.sku} : sous-titre « boîte de vitesses »`);
    }
    const de = await get(`/de/produits/${encodeURIComponent(DQ200.localizations.de.slug)}-${DQ200._id}`);
    assert.equal(de.status, 200);
    assert.ok(texte(de.html).includes('Nur gesetzliche Gewährleistung'), 'allemand : garantie de l’occasion');
    assert.ok(!/Kein Rückgriff|für dieses Getriebe/.test(texte(de.html)), 'allemand : ancien texte');

    /* WC-7756 : 12 véhicules, 7 références. Les 7 premiers recevaient chacun
       une référence par sa POSITION dans la liste, les 5 suivants le SKU
       interne. Aucune référence n'est rattachée à un véhicule en base : le
       tableau n'en montre plus, la fiche les liste une fois, à part. */
    for (const p of [WC, DQ200]) {
      const compat = sectionCompat(pages.get(p.sku));
      assert.ok(compat, `${p.sku} : bloc des véhicules compatibles absent`);
      assert.ok(texte(compat).includes(p.compatibility[p.compatibility.length - 1].model), `${p.sku} : les véhicules doivent rester`);
      assert.ok(!compat.includes(p.sku), `${p.sku} : SKU interne affiché comme référence d’un véhicule`);
      for (const r of p.compatibleReferences) assert.ok(!compat.includes(`>${r}<`), `${p.sku} : ${r} attribuée à un véhicule`);
      assert.ok(!texte(compat).includes('Références'), `${p.sku} : colonne « Références » encore là`);
      const lisible = texte(pages.get(p.sku));
      for (const r of p.compatibleReferences) assert.ok(lisible.includes(r), `${p.sku} : ${r} doit rester listée dans les caractéristiques`);
    }
  });

  await t.test('le flux Merchant liste toujours toutes les fiches publiées', async () => {
    const r = await get('/google-merchant-feed.xml');
    assert.equal(r.status, 200);
    for (const p of FIXTURE.produits) {
      assert.ok(r.html.includes(`/product/${p.slug}`), `${p.sku} absent du flux Merchant`);
    }
  });
});
