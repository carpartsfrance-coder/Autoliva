'use strict';

/* Table FR → DE du VOCABULAIRE des options produit (« Clonage », « Avec
 * programmation », « Ancienne pièce disponible pour l'échange standard »…).
 *
 * Pourquoi une table plutôt qu'un champ traduit dans le schéma : une option
 * est un objet imbriqué avec ses choix, et une copie allemande parallèle
 * dérive au premier ajout de choix — on afficherait alors le prix d'un choix
 * sous le libellé d'un autre. La table indexe par TEXTE : elle ne peut pas se
 * désaligner, et une option ajoutée demain qui réemploie le même vocabulaire
 * est traduite sans rien relancer.
 *
 * Usage :
 *   node scripts/build-options-de.js              # extrait, n'appelle rien
 *   node scripts/build-options-de.js --traduire
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');

const SORTIE = path.join(__dirname, '..', 'src', 'locales', 'optionsDe.json');
const LOT = 40;

/* Une référence n'est pas du texte : « 927769D », « AWD », « 0B5 » doivent
   traverser intacts. On ne retient que ce qui contient un vrai mot. */
function estTraduisible(s) {
  const t = String(s || '').trim();
  if (t.length < 3 || t.length > 400) return false;
  if (!/[a-zà-ÿ]{3}/.test(t)) return false;          // aucun mot en minuscules
  if (/^[A-Z0-9][A-Z0-9\s\-/.]*$/.test(t)) return false; // suite de codes
  return true;
}

async function main() {
  const traduire = process.argv.includes('--traduire');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Product = require('../src/models/Product');

  const docs = await Product.find({ 'options.0': { $exists: true } }).select('options').lean();
  const voc = new Set();
  for (const p of docs) {
    for (const o of (p.options || [])) {
      for (const champ of ['label', 'placeholder', 'helpText']) {
        if (estTraduisible(o[champ])) voc.add(String(o[champ]).trim());
      }
      for (const c of (o.choices || [])) {
        if (estTraduisible(c.label)) voc.add(String(c.label).trim());
      }
    }
  }
  const liste = [...voc].sort();
  console.log(docs.length + ' fiche(s) à options — ' + liste.length + ' expression(s) traduisible(s).');

  let table = {};
  if (fs.existsSync(SORTIE)) table = JSON.parse(fs.readFileSync(SORTIE, 'utf8'));
  const manquants = liste.filter((s) => !table[s]);
  console.log(manquants.length + ' à traduire'
    + (manquants.length ? ' — ' + Math.ceil(manquants.length / LOT) + ' appel(s) API' : '') + '.');

  if (!traduire) {
    console.log('\nEssai à blanc : rien appelé, rien écrit.');
    manquants.slice(0, 12).forEach((s) => console.log('   ' + JSON.stringify(s.slice(0, 80))));
    await mongoose.disconnect();
    return;
  }
  if (!manquants.length) { await mongoose.disconnect(); return; }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');
  for (let i = 0; i < manquants.length; i += LOT) {
    const lot = manquants.slice(i, i + LOT);
    let out;
    try {
      out = await translator._impl.callOpenAI({ libelles: lot }, { apiKey, model: 'gpt-4o-mini' });
    } catch (e) {
      console.log('\n  ✗ lot ' + (i / LOT + 1) + ' : ' + e.message);
      continue;
    }
    const arr = out && Array.isArray(out.libelles) ? out.libelles : null;
    if (!arr || arr.length !== lot.length) { console.log('\n  ✗ lot ' + (i / LOT + 1) + ' : longueur incohérente'); continue; }
    lot.forEach((fr, k) => {
      const de = String(arr[k] || '').trim();
      /* Les codes cités DANS le libellé (« Code boîte 0B5 ») doivent survivre. */
      const codes = fr.match(/\b[A-Z0-9]{3,}\b/g) || [];
      if (de && codes.every((c) => de.includes(c))) table[fr] = de;
    });
    process.stdout.write('\r… ' + Math.min(i + LOT, manquants.length) + '/' + manquants.length + '   ');
  }
  const ordonnee = {};
  for (const k of Object.keys(table).sort()) ordonnee[k] = table[k];
  fs.writeFileSync(SORTIE, JSON.stringify(ordonnee, null, 2) + '\n', 'utf8');
  console.log('\n' + Object.keys(ordonnee).length + ' entrées → ' + SORTIE);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
}
