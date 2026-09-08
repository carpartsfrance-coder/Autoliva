'use strict';

/* Construit src/locales/emails-de.json : la table FR → DE des e-mails.
 *
 * L'extraction imite EXACTEMENT ce que verra emailI18n au runtime — on
 * découpe les sources sur les balises et on ne garde que les nœuds de texte.
 * Une clé extraite autrement ne serait jamais retrouvée à l'exécution.
 *
 * Usage :
 *   node scripts/build-emails-de.js              # extrait + liste, n'appelle rien
 *   node scripts/build-emails-de.js --traduire   # complète les entrées manquantes
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const glob = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? glob(path.join(dir, e.name), ext)
    : (e.name.endsWith(ext) ? [path.join(dir, e.name)] : [])));

const translator = require('../src/services/productTranslator');
const { normaliser } = require('../src/services/emailI18n');

const SORTIE = path.join(__dirname, '..', 'src', 'locales', 'emails-de.json');
const LOT = 40;

const SOURCES = [
  'src/services/emailTemplates.js',
  'src/services/leadEmailTemplates.js',
  'src/services/engineQuoteEmail.js',
  ...glob(path.join('src', 'views', 'emails'), '.ejs'),
];

/* Un segment n'est retenu que s'il contient du français reconnaissable : on
   écarte ainsi les nombres, les codes, les URLs et le CSS résiduel. */
const FR = /[àâäéèêëîïôöùûüçœ]|\b(le|la|les|des|une|un|du|de|pour|avec|votre|vos|nos|notre|est|sont|vous|nous|et|ou|dans|sur|par|au|aux|ce|cette|qui|que|si|plus|tout|sans|bonjour|merci|commande|livraison|panier|piece|facture|retour|suivi|paiement|adresse|quantite|total|prix|garantie|jour|jours|expedition)\b/i;
const EXCLURE = /^(https?:|mailto:|#|\{|\}|[\d\s.,:;%€$+\-*/()[\]|]+$)/;
/* Une interpolation imbriquée laisse du code dans le nœud de texte : un
   segment qui ressemble encore à du JavaScript n'a rien à faire dans une
   table de traduction. */
const RESTE_DE_CODE = /\$\{|=>|\.filter\(|\.map\(|\?\s*'|\|\||&&|\bfunction\b|\breturn\b|\bconst\b|\bvar\b|[`{}]|'\s*\+|\+\s*'|\w+\s*:\s*(renderEmailLayout|escapeHtml|formatEuro)|^[)\]},;]/;

/* Retire les commentaires : sans ça l'extraction ramassait la documentation
   des modules, qui est aussi en français. */
function sansCommentaires(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
}

/* Les échappements du source (\n, \u00e9) doivent être résolus : au runtime
   le client reçoit le caractère, pas la séquence. */
function desechapper(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, ' ')
    .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`');
}

/* Les littéraux de chaîne, seuls endroits où vit le texte envoyé au client.
   On ne découpe PAS sur l'apostrophe : « si ce n'est pas » est du français,
   pas deux fragments. */
function litterauxJs(js) {
  const out = [];
  const re = /`(?:[^`\\]|\\.)*`|'(?:[^'\n\\]|\\.)*'|"(?:[^"\n\\]|\\.)*"/g;
  let m;
  while ((m = re.exec(js)) !== null) out.push(desechapper(m[0].slice(1, -1)));
  return out;
}

/* Découpage identique à emailI18n.traduireHtml : hors balise = texte. */
function noeudsDeTexte(html) {
  const out = [];
  let horsTexte = 0;
  html.replace(/(<[^>]*>)|([^<]+)/g, (m, balise, texte) => {
    if (balise) {
      if (/^<\s*(style|script)\b/i.test(balise)) horsTexte++;
      else if (/^<\s*\/\s*(style|script)\s*>/i.test(balise)) horsTexte = Math.max(0, horsTexte - 1);
      return m;
    }
    if (horsTexte === 0) out.push(texte);
    return m;
  });
  return out;
}

function segmentsDe(source, estEjs) {
  const out = new Set();
  /* Les gabarits SAV rangent tout leur HTML dans un littéral à l'intérieur
     d'un bloc <% %> : les ignorer revenait à n'extraire rien du tout. On prend
     donc les deux, le balisage brut ET les littéraux des blocs de code. */
  let morceaux;
  if (estEjs) {
    const propre = source.replace(/<%#[\s\S]*?%>/g, ' ').replace(/<%\/\*[\s\S]*?\*\/%>/g, ' ');
    const blocs = (propre.match(/<%[^=\-][\s\S]*?%>/g) || []).join('\n');
    morceaux = [propre.replace(/<%[^=\-][\s\S]*?%>/g, ' ')].concat(litterauxJs(blocs));
  } else {
    /* Les littéraux IMBRIQUÉS (un `...` dans un ${...}) faisaient dérailler
       le découpage : le littéral extérieur se terminait au premier backtick
       intérieur, et tout ce qui suivait était perdu — « Réf : », « Articles »,
       « Voir ma commande »… On ajoute donc la source entière découpée sur les
       balises ; les restes de code sont écartés par les mêmes filtres. */
    const propre = sansCommentaires(source);
    morceaux = litterauxJs(propre).concat([desechapper(propre)]);
  }

  for (const morceau of morceaux) {
    for (const noeud of noeudsDeTexte(morceau)) {
      /* Une interpolation coupe le nœud de texte à l'exécution : on découpe
         au même endroit, sinon la clé ne serait jamais retrouvée. */
      for (const brut of noeud.split(/\$\{[^}]*\}|<%[-=][\s\S]*?%>/)) {
        const s = normaliser(brut);
        if (s.length < 3 || s.length > 300) continue;
        if (EXCLURE.test(s) || !FR.test(s)) continue;
        if (RESTE_DE_CODE.test(s)) continue;
        out.add(s);
      }
    }
  }
  return out;
}

async function main() {
  const traduire = process.argv.includes('--traduire');
  const toutes = new Set();
  for (const f of SOURCES) {
    const seg = segmentsDe(fs.readFileSync(f, 'utf8'), f.endsWith('.ejs'));
    console.log(String(seg.size).padStart(4), f.replace('src/', ''));
    for (const s of seg) toutes.add(s);
  }
  const liste = [...toutes].sort();
  console.log('\n' + liste.length + ' segment(s) distinct(s).');

  let table = {};
  if (fs.existsSync(SORTIE)) table = JSON.parse(fs.readFileSync(SORTIE, 'utf8'));
  const manquants = liste.filter((s) => !table[s]);
  console.log(manquants.length + ' à traduire' + (manquants.length ? ' — ' + Math.ceil(manquants.length / LOT) + ' appel(s) API' : '') + '.');

  if (!traduire) {
    console.log('\nEssai à blanc : rien appelé, rien écrit. Relance avec --traduire.');
    manquants.slice(0, 15).forEach((s) => console.log('   ' + JSON.stringify(s.slice(0, 90))));
    return;
  }
  if (!manquants.length) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');
  for (let i = 0; i < manquants.length; i += LOT) {
    const lot = manquants.slice(i, i + LOT);
    const out = await translator._impl.callOpenAI({ libelles: lot }, { apiKey, model: 'gpt-4o-mini' });
    const arr = out && Array.isArray(out.libelles) ? out.libelles : null;
    if (!arr || arr.length !== lot.length) {
      console.log('  ✗ lot ' + (i / LOT + 1) + ' : longueur incohérente, laissé en français');
      continue;
    }
    lot.forEach((fr, k) => {
      const de = String(arr[k] || '').trim();
      /* Une traduction qui perd une variable casserait le message. */
      const vars = (fr.match(/%[a-zA-Z]+%/g) || []);
      if (de && vars.every((v) => de.includes(v))) table[fr] = de;
    });
    process.stdout.write('\r… ' + Math.min(i + LOT, manquants.length) + '/' + manquants.length + '   ');
  }
  const ordonnee = {};
  for (const k of Object.keys(table).sort()) ordonnee[k] = table[k];
  fs.writeFileSync(SORTIE, JSON.stringify(ordonnee, null, 2) + '\n', 'utf8');
  console.log('\n' + Object.keys(ordonnee).length + ' entrées → ' + SORTIE);
}

if (require.main === module) {
  main().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
}
module.exports = { segmentsDe };
