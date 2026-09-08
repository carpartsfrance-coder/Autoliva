'use strict';

require('dotenv').config();

/* Traduit le VOCABULAIRE des pastilles et des délais, pas les fiches.
 *
 * ── Pourquoi ce script (09/2026) ────────────────────────────────────────────
 *
 * 10 055 fiches affichaient encore « Reconditionné » ou « Occasion » en
 * français sous un titre allemand. La réaction réflexe était de relancer la
 * traduction complète du catalogue : 14 730 appels à l'API, ~4 €, 2 h 30.
 *
 * C'est absurde. Ces 10 055 pastilles ne contiennent que 24 états distincts,
 * 21 mentions de garantie et 390 libellés de cartes — moins de 450 chaînes,
 * courtes, qui reviennent des milliers de fois. On traduit le vocabulaire UNE
 * fois (quelques appels, quelques centimes), on l'applique à tout le
 * catalogue, et on garde la table sur disque : la prochaine fois, c'est
 * gratuit.
 *
 * Le garde-fou d'état est la raison d'être du contrôle en sortie : une
 * pastille « Occasion » qui reviendrait en « Generalüberholt » annoncerait au
 * client allemand une pièce refaite à neuf. Sur une chaîne aussi courte, la
 * vérification est certaine — on compare l'état déclaré des deux côtés, et on
 * refuse la traduction en cas de désaccord.
 *
 * Usage :
 *   node scripts/fix-badges-de.js              # DRY-RUN, n'écrit rien
 *   node scripts/fix-badges-de.js --appliquer  # écrit localizations.de.badges
 *   --model NAME    modèle OpenAI (défaut gpt-4o-mini)
 *   --revocabulaire ignore la table en cache et retraduit le vocabulaire
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');

const CACHE = path.join(__dirname, 'badges-de.json');
/* Les délais d'expédition sont dans la même situation que les pastilles :
   7 017 fiches allemandes affichaient « 3-5 jours » ou « Sur demande » en
   français. 62 libellés distincts, courts et sans ambiguïté — écrits à la
   main, ils ne coûtent pas un appel. */
const CACHE_DELAIS = path.join(__dirname, 'delais-de.json');
const LOT = 40;

function flag(n) { return process.argv.includes(n); }
function opt(n, d) {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
}

/* ── Garde-fou d'état ──────────────────────────────────────────────────────
   Un seul mot sépare une pièce d'occasion d'une pièce refaite à neuf, et
   c'est ce mot qui justifie l'écart de prix. On ne laisse pas passer un
   désaccord entre les deux langues. */
function etatFr(s) {
  const t = String(s).toLowerCase();
  if (/reconditionn|échange standard|echange standard|rénovation|renovation/.test(t)) return 'reconditionné';
  if (/occasion/.test(t)) return 'occasion';
  if (/\bneuf\b|\bneuve\b/.test(t)) return 'neuf';
  return null;
}
function etatDe(s) {
  const t = String(s).toLowerCase();
  if (/generalüberholt|überholt|austausch|instandgesetzt/.test(t)) return 'reconditionné';
  if (/gebraucht/.test(t)) return 'occasion';
  /* L'allemand soude ses composés : « Neuteil », « Neuwagen », « neuwertig ».
     On accepte donc tout mot COMMENÇANT par « neu », en écartant les deux
     familles qui n'ont rien à voir : « neun » (le chiffre neuf) et
     « neutral ». Le français « neuf » a le même piège, en pire. */
  if (/\bneu(?!n|tral)/.test(t)) return 'neuf';
  return null;
}
function etatCoherent(fr, de) {
  const a = etatFr(fr); const b = etatDe(de);
  if (!a || !b) return true; /* aucune revendication d'état : rien à vérifier */
  return a === b;
}

/* Une pastille est un libellé d'interface, pas une phrase : si le français
   commence par une majuscule, l'allemand aussi. Sans ça le catalogue mélangeait
   « Gebraucht » et « generalüberholt » dans la même colonne. */
function casseDuFrancais(fr, de) {
  const t = String(de || '').trim();
  if (!t) return '';
  const premiere = String(fr).trim()[0];
  if (premiere && premiere === premiere.toUpperCase() && premiere !== premiere.toLowerCase()) {
    return t[0].toUpperCase() + t.slice(1);
  }
  return t;
}

async function traduireLot(libelles, { apiKey, model }) {
  const out = await translator._impl.callOpenAI({ libelles }, { apiKey, model });
  const arr = out && Array.isArray(out.libelles) ? out.libelles : null;
  if (!arr || arr.length !== libelles.length) throw new Error('longueur incohérente (' + (arr ? arr.length : 'absent') + ' au lieu de ' + libelles.length + ')');
  return arr.map((s) => String(s || '').trim());
}

async function main() {
  const appliquer = flag('--appliquer');
  const model = opt('--model', 'gpt-4o-mini');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const Product = require('../src/models/Product');

  /* ── 1. Le vocabulaire réellement employé ─────────────────────────────── */
  const produits = await Product.find({})
    .select('badges shippingDelayText localizations.de.badges localizations.de.shippingDelayText')
    .lean();
  const vocabulaire = new Set();
  for (const p of produits) {
    const b = p.badges || {};
    if (b.topLeft) vocabulaire.add(b.topLeft.trim());
    if (b.condition) vocabulaire.add(b.condition.trim());
    for (const c of (b.cards || [])) if (c && String(c).trim()) vocabulaire.add(String(c).trim());
  }
  const tous = [...vocabulaire].sort();
  console.log(produits.length + ' fiches — ' + tous.length + ' libellés distincts à couvrir.');

  /* ── 2. Table de traduction (cache disque) ────────────────────────────── */
  let table = {};
  if (!flag('--revocabulaire') && fs.existsSync(CACHE)) {
    table = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    console.log('table en cache : ' + Object.keys(table).length + ' libellés déjà traduits.');
  }
  const manquants = tous.filter((s) => !table[s]);
  console.log(manquants.length + ' libellé(s) à traduire' + (manquants.length ? ' — ' + Math.ceil(manquants.length / LOT) + ' appel(s) API' : '') + '.');

  let refuses = 0;
  if (manquants.length) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY manquante');
    for (let i = 0; i < manquants.length; i += LOT) {
      const lot = manquants.slice(i, i + LOT);
      let de;
      try {
        de = await traduireLot(lot, { apiKey, model });
      } catch (e) {
        console.log('  ✗ lot ' + (i / LOT + 1) + ' : ' + e.message + ' → libellés laissés en français');
        continue;
      }
      lot.forEach((fr, k) => {
        const trad = casseDuFrancais(fr, de[k]);
        if (!trad) return;
        if (!etatCoherent(fr, trad)) {
          refuses++;
          console.log('  ⚠ refusé (état) : « ' + fr + ' » → « ' + trad + ' »');
          return;
        }
        table[fr] = trad;
      });
      process.stdout.write('\r… ' + Math.min(i + LOT, manquants.length) + '/' + manquants.length + ' libellés   ');
    }
    console.log('');
    fs.writeFileSync(CACHE, JSON.stringify(table, null, 2), 'utf8');
    console.log('table écrite → ' + CACHE + ' (les prochains passages seront gratuits)');
  }
  if (refuses) console.log(refuses + ' traduction(s) refusée(s) pour incohérence d’état — ces pastilles restent en français.');

  /* ── 3. Application au catalogue ──────────────────────────────────────── */
  const delais = fs.existsSync(CACHE_DELAIS) ? JSON.parse(fs.readFileSync(CACHE_DELAIS, 'utf8')) : {};
  const manqueDelai = new Set();
  const trad = (s) => (s && table[String(s).trim()]) || '';
  const tradDelai = (s) => {
    const k = String(s || '').trim();
    if (!k) return '';
    if (delais[k]) return delais[k];
    manqueDelai.add(k);
    return '';
  };
  const ops = [];
  let inchangees = 0;
  for (const p of produits) {
    const b = p.badges || {};
    const de = (p.localizations && p.localizations.de) || {};
    const set = {};

    const cible = {};
    if (b.topLeft) cible.topLeft = trad(b.topLeft) || b.topLeft;
    if (b.condition) cible.condition = trad(b.condition) || b.condition;
    if (Array.isArray(b.cards) && b.cards.length) cible.cards = b.cards.map((c) => trad(c) || c);
    if (Object.keys(cible).length) {
      const actuel = de.badges || {};
      const identique = JSON.stringify({ t: actuel.topLeft || '', c: actuel.condition || '', k: actuel.cards || [] })
        === JSON.stringify({ t: cible.topLeft || '', c: cible.condition || '', k: cible.cards || [] });
      if (!identique) set['localizations.de.badges'] = cible;
    }

    /* Délai d'expédition : on n'écrit QUE si on a une traduction. Laisser le
       français serait moins visible qu'une case vide, mais ce serait mentir sur
       la langue de la page — on préfère ne rien écrire et le signaler. */
    const cibleDelai = tradDelai(p.shippingDelayText);
    if (cibleDelai && cibleDelai !== (de.shippingDelayText || '')) {
      set['localizations.de.shippingDelayText'] = cibleDelai;
    }

    if (!Object.keys(set).length) { inchangees++; continue; }
    ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: set } } });
  }

  if (manqueDelai.size) {
    console.log('\n' + manqueDelai.size + ' délai(s) absent(s) de ' + path.basename(CACHE_DELAIS) + ' — restés vides :');
    for (const d of [...manqueDelai].slice(0, 20)) console.log('   ' + JSON.stringify(d));
  }

  console.log('\n' + ops.length + ' fiche(s) à mettre à jour, ' + inchangees + ' déjà correcte(s) ou sans pastille.');

  const apercu = ops.slice(0, 5);
  for (const o of apercu) {
    const p = produits.find((x) => String(x._id) === String(o.updateOne.filter._id));
    const $set = o.updateOne.update.$set;
    const badges = $set['localizations.de.badges'];
    if (badges) console.log('  pastille  ' + JSON.stringify((p.badges || {}).condition || '') + ' → ' + JSON.stringify(badges.condition || ''));
    if ($set['localizations.de.shippingDelayText']) {
      console.log('  délai     ' + JSON.stringify(p.shippingDelayText || '') + ' → ' + JSON.stringify($set['localizations.de.shippingDelayText']));
    }
  }

  if (!appliquer) {
    console.log('\nDRY-RUN : rien écrit en base. Relance avec --appliquer pour appliquer.');
  } else if (ops.length) {
    for (let i = 0; i < ops.length; i += 500) {
      await Product.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      process.stdout.write('\r… écrit ' + Math.min(i + 500, ops.length) + '/' + ops.length + '   ');
    }
    console.log('\n✅ ' + ops.length + ' fiche(s) mises à jour.');
  }

  await mongoose.disconnect();
}

/* Le garde-fou est exporté pour être testé : c'est la pièce qui empêche
   d'annoncer une occasion comme refaite à neuf. */
module.exports = { etatFr, etatDe, etatCoherent };

if (require.main === module) {
  main().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
}
