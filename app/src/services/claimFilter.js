'use strict';

/**
 * Filtre des allégations non prouvées — appliqué à l'AFFICHAGE, jamais en base.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A3 e) ────────────────
 *
 * La description des fiches revient à l'écran après deux mois d'absence. Or les
 * textes importés en masse promettent des choses que personne n'a prouvées :
 *   - « usine certifiée ISO 9001 » sur 1 859 boîtes (ALV-BX, DEK, EDN), plus un
 *     badge « Norme ISO 9001 » et une FAQ sur 2 637 fiches ;
 *   - « dans notre atelier » sur 2 493 moteurs Asysum, reconditionnés chez un
 *     partenaire ;
 *   - « qui équipent directement les concessionnaires » ;
 *   - « 3× sans frais » (badge et FAQ de 779 moteurs d'occasion) alors que
 *     Scalapay est coupé depuis le 05/08 ;
 *   - et, sur les 724 pages véhicule rédigées en base, « 3x ou 4x sans frais via
 *     Scalapay », « garantie de 24 mois » et « nos ateliers ».
 * Tant que la décision 4 (preuves ISO, atelier, garanties) n'est pas rendue,
 * la règle est de ne rien affirmer qu'on ne puisse montrer. Réécrire 13 000
 * fiches en base n'est ni réaliste ni réversible : on filtre au rendu, et la
 * politique vit dans un fichier versionné (src/data/seo/claims-policy.json).
 *
 * ── Ce que fait le filtre ─────────────────────────────────────────────────────
 *
 * 1. Réécritures au niveau de l'EXPRESSION, volontairement strictes (liste
 *    fermée, éprouvée sur les 13 362 fiches publiées) : « usine certifiée
 *    ISO 9001 » → « usine spécialisée », « dans notre atelier » → « chez notre
 *    partenaire reconditionneur »… Une expression trop large couperait du texte
 *    utile ; une expression oubliée laisse passer une allégation — c'est pour
 *    cela que les deux filets ci-dessous existent.
 * 2. Retrait de la PHRASE (ou de l'élément d'une liste « a · b · c ») qui porte
 *    encore une allégation : une mention d'ISO 9001 que rien n'a réécrite (y
 *    compris en allemand), un paiement en 3x/4x tant que Scalapay est coupé, une
 *    durée de garantie qui contredit warranty.months de la fiche.
 * 3. Rien ne change quand aucune règle ne s'applique : le texte ressort
 *    identique, octet pour octet.
 *
 * Le HTML est respecté : les balises sont mises de côté pendant le travail sur
 * le texte, et une balise ouverte dans une phrase retirée mais fermée plus loin
 * est conservée — le balisage reste équilibré.
 */

const POLITIQUE = require('../data/seo/claims-policy.json');

const FAMILLE_PAR_DEFAUT = POLITIQUE.familleParDefaut || 'AUTRES';
const FAMILLE_LANDING = POLITIQUE.familleLandingVehicule || 'PAGES-VEHICULE';

/* ─── Familles et règles actives ──────────────────────────────────────────── */

/* Préfixes triés du plus long au plus court : « ALV-BX- » et « ALV-PT- » ne
   doivent jamais être confondus. */
const PREFIXES = [];
for (const f of (Array.isArray(POLITIQUE.familles) ? POLITIQUE.familles : [])) {
  for (const p of (Array.isArray(f.prefixes) ? f.prefixes : [])) {
    PREFIXES.push({ prefixe: String(p).trim().toUpperCase(), cle: f.cle });
  }
}
PREFIXES.sort((a, b) => b.prefixe.length - a.prefixe.length);

function familleDuSku(sku) {
  const s = String(sku || '').trim().toUpperCase();
  if (!s) return FAMILLE_PAR_DEFAUT;
  for (const { prefixe, cle } of PREFIXES) {
    if (s.startsWith(prefixe)) return cle;
  }
  return FAMILLE_PAR_DEFAUT;
}

function reglesActives(famille, { scalapayActif = false } = {}) {
  const actives = new Set();
  const regles = POLITIQUE.regles && typeof POLITIQUE.regles === 'object' ? POLITIQUE.regles : {};
  for (const [id, r] of Object.entries(regles)) {
    if (!r || r.active === false) continue;
    if (Array.isArray(r.leveePour) && r.leveePour.includes(famille)) continue;
    /* Le 3x/4x n'est une fausse promesse QUE si le moyen de paiement est coupé :
       le jour où Scalapay revient, les textes redeviennent vrais. */
    if (id === 'paiementFractionne' && scalapayActif) continue;
    actives.add(id);
  }
  return actives;
}

function moisDeGarantie(product) {
  const m = product && product.warranty ? Number(product.warranty.months) : NaN;
  return Number.isFinite(m) && m > 0 ? m : null;
}

/** Contexte d'une fiche : sa famille (préfixe SKU), ses règles, sa garantie. */
function contexteFiche(product, { scalapayActif = false } = {}) {
  const famille = familleDuSku(product && product.sku);
  return {
    famille,
    regles: reglesActives(famille, { scalapayActif }),
    dureeGarantieMois: moisDeGarantie(product),
    portee: 'fiche',
  };
}

/** Contexte d'une page véhicule : elle regroupe des pièces aux garanties
 *  différentes, donc aucune durée n'y est vraie pour toutes. */
function contexteLanding({ scalapayActif = false } = {}) {
  return {
    famille: FAMILLE_LANDING,
    regles: reglesActives(FAMILLE_LANDING, { scalapayActif }),
    dureeGarantieMois: null,
    portee: 'landing',
  };
}

/**
 * Article de blog : les mêmes règles que les pages, SAUF la durée de
 * garantie. Un article parle de pièces précises — beaucoup sont bien
 * garanties 24 mois — et sans fiche de référence, retirer toute durée
 * effacerait du vrai. Les durées des articles relèvent de la relecture
 * humaine (plan SEO A17).
 */
function contexteArticle({ scalapayActif = false } = {}) {
  const regles = reglesActives(FAMILLE_LANDING, { scalapayActif });
  regles.delete('dureeGarantie');
  return { famille: FAMILLE_LANDING, regles, dureeGarantieMois: null, portee: 'article' };
}

/* ─── Description masquée ─────────────────────────────────────────────────── */

/**
 * Famille dont la description ne doit JAMAIS servir, pas même de repli pour la
 * balise meta : « DM » (copie mot pour mot de distrimotor.com), « ALIBABA »
 * (état et garantie à confirmer, décision 4). null sinon.
 */
function familleADescriptionMasquee(product) {
  const famille = familleDuSku(product && product.sku);
  const table = POLITIQUE.descriptionMasquee && typeof POLITIQUE.descriptionMasquee === 'object'
    ? POLITIQUE.descriptionMasquee
    : {};
  return Object.prototype.hasOwnProperty.call(table, famille) ? famille : null;
}

/* Valeurs qui COUPENT l'interrupteur. « off » est la valeur documentée, mais
   c'est un bouton d'urgence, tapé à la main sur Render : un « false » ou un
   « 0 » qui ne couperait rien laisserait croire au retour arrière. */
const INTERRUPTEUR_COUPE = new Set(['off', 'false', '0', 'no', 'non']);

/**
 * Raison pour laquelle le bloc « Description » n'est PAS affiché, ou null.
 *   'interrupteur' — SHOW_PRODUCT_DESCRIPTION=off (retour arrière sans code) ;
 *   'langue'       — la page n'est pas en français : les descriptions
 *                    allemandes sont des traductions automatiques non relues ;
 *   'famille:DM' / 'famille:ALIBABA' — voir familleADescriptionMasquee.
 * Lu à chaque requête : un changement de variable prend effet au redémarrage
 * du service (« Save and deploy » sur Render).
 */
function motifDescriptionMasquee(product, { lang = 'fr' } = {}) {
  if (INTERRUPTEUR_COUPE.has(String(process.env.SHOW_PRODUCT_DESCRIPTION || '').trim().toLowerCase())) return 'interrupteur';
  if (lang !== 'fr') return 'langue';
  const famille = familleADescriptionMasquee(product);
  return famille ? `famille:${famille}` : null;
}

/* ─── Réécritures au niveau de l'expression ───────────────────────────────── */

/* Majuscule conservée : « Dans notre atelier » → « Chez notre partenaire… ». */
function avecCasse(source, remplacement) {
  const c = String(source || '').charAt(0);
  if (!remplacement || !c || c === c.toLowerCase()) return remplacement;
  return remplacement.charAt(0).toUpperCase() + remplacement.slice(1);
}

const PLURIEL = /^(nos|des)\b/i;
function partenaire(possessif) {
  return PLURIEL.test(possessif) ? 'nos partenaires reconditionneurs' : 'notre partenaire reconditionneur';
}

/* « de notre atelier » ne devient « de CHEZ notre partenaire » qu'après un mot
   de mouvement (« sort de », « part de », « au départ de ») : ailleurs, « chez »
   est fautif — « passe entre les mains de chez notre partenaire » ne se dit
   pas. Le mot qui précède est lu dans le texte même (arguments du replace). */
const MOUVEMENT_AVANT = /(?:^|[^\wÀ-ÿ])(?:sort\w*|part|partent|partir|parti|partie|départ|provien\w*)\s+$/i;

/* L'ordre compte : les formes longues avant les formes génériques. */
const REECRITURES = [
  /* ISO 9001 — la certification n'est pas prouvée ; « spécialisée » reste vrai. */
  { regle: 'iso9001', motif: /\ben usine\s*\(\s*norme ISO\s?9001\s*\)/gi, par: (m) => avecCasse(m, 'en usine spécialisée') },
  { regle: 'iso9001', motif: /\ben usine selon la norme ISO\s?9001/gi, par: (m) => avecCasse(m, 'en usine spécialisée') },
  { regle: 'iso9001', motif: /\ben usine ISO\s?9001/gi, par: (m) => avecCasse(m, 'en usine spécialisée') },
  { regle: 'iso9001', motif: /\b(usines?) certifiées? ISO\s?9001/gi, par: (m, u) => avecCasse(u, /s$/i.test(u) ? 'usines spécialisées' : 'usine spécialisée') },
  { regle: 'iso9001', motif: /\batelier partenaire certifié ISO\s?9001/gi, par: (m) => avecCasse(m, 'atelier partenaire spécialisé') },
  { regle: 'iso9001', motif: /\s*\(\s*(?:usine|norme) ISO\s?9001\s*\)/gi, par: '' },

  /* « Fournisseur des concessionnaires » : jamais documenté. */
  { regle: 'concessionnaires', motif: /\s*\(\s*fournisseurs? des concessionnaires\s*\)/gi, par: '' },
  { regle: 'concessionnaires', motif: /,?\s*qui équipent directement les concessionnaires/gi, par: '' },
  { regle: 'concessionnaires', motif: /\s*[—–]\s*fournisseurs? des concessionnaires/gi, par: '' },

  /* Atelier ou usine « à nous » : le reconditionnement est fait chez des
     partenaires. On garde l'accord (singulier/pluriel) et la préposition. */
  {
    regle: 'atelierPropre',
    motif: /\bquitter (notre atelier|nos ateliers)/gi,
    par: (m, g) => avecCasse(m, PLURIEL.test(g)
      ? 'quitter les ateliers de nos partenaires reconditionneurs'
      : 'quitter l’atelier de notre partenaire reconditionneur'),
  },
  /* « notre réseau d'ateliers » : même allégation au pluriel. « …d'ateliers
     PARTENAIRES » dit déjà vrai : laissé tel quel. */
  {
    regle: 'atelierPropre',
    motif: /\b(dans|de|par) notre réseau d['’]ateliers(?!\s+partenaires)(?![\wÀ-ÿ])/gi,
    par: (m, prep) => avecCasse(prep, prep.toLowerCase() === 'dans' ? 'chez nos partenaires reconditionneurs' : `${prep.toLowerCase()} nos partenaires reconditionneurs`),
  },
  { regle: 'atelierPropre', motif: /\bnotre réseau d['’]ateliers(?!\s+partenaires)(?![\wÀ-ÿ])/gi, par: (m) => avecCasse(m, 'nos partenaires reconditionneurs') },
  /* « Autoliva le reconditionne… dans son atelier » : l'atelier de la marque.
     Seulement quand la marque est le sujet — « le garagiste le monte dans son
     atelier » parle du client et reste intact. */
  {
    regle: 'atelierPropre',
    motif: /(\b(?:Autoliva|Car\s?Parts\s?France)\b[^.!?\n]{0,80}?)\bdans son atelier(?![\wÀ-ÿ])/gi,
    par: (m, debut) => `${debut}chez son partenaire reconditionneur`,
  },
  {
    regle: 'atelierPropre',
    motif: /\b(dans|de|depuis|par) ((?:notre|nos) (?:atelier|ateliers|usine|usines))(?:\s+(?:spécialisée?s?|partenaires?|de reconditionnement))?(?![\wÀ-ÿ])/gi,
    par: (m, prep, groupe, position, chaine) => {
      const p = prep.toLowerCase();
      const cible = partenaire(groupe);
      const deChez = p === 'de' && MOUVEMENT_AVANT.test(chaine.slice(Math.max(0, position - 30), position));
      const txt = p === 'dans' ? `chez ${cible}` : deChez ? `de chez ${cible}` : `${p} ${cible}`;
      return avecCasse(prep, txt);
    },
  },
  {
    regle: 'atelierPropre',
    motif: /\b((?:notre|nos) (?:atelier|ateliers|usine|usines))(?:\s+(?:spécialisée?s?|partenaires?|de reconditionnement))?(?![\wÀ-ÿ])/gi,
    par: (m, groupe) => avecCasse(groupe, partenaire(groupe)),
  },
  /* Même allégation dans le gabarit ALLEMAND : « Von unseren Werkstätten aus »
     s'affiche sous la photo de chargement de chaque fiche /de. « Partner- »
     garde la phrase et dit vrai. */
  { regle: 'atelierPropre', motif: /\bunseren Werkstätten(?![\wÀ-ÿ])/gi, par: (m) => avecCasse(m, 'unseren Partnerwerkstätten') },
  { regle: 'atelierPropre', motif: /\bunsere Werkstätten(?![\wÀ-ÿ])/gi, par: (m) => avecCasse(m, 'unsere Partnerwerkstätten') },
  { regle: 'atelierPropre', motif: /\bunserer Werkstatt(?![\wÀ-ÿ])/gi, par: (m) => avecCasse(m, 'unserer Partnerwerkstatt') },
  { regle: 'atelierPropre', motif: /\bunsere Werkstatt(?![\wÀ-ÿ])/gi, par: (m) => avecCasse(m, 'unsere Partnerwerkstatt') },

  /* Superlatif invérifiable. */
  { regle: 'couvertureLaPlusLongue', motif: /\s*[—–,]?\s*(?:la )?couverture la plus longue du marché(?:\s+sur\s+(?:ce modèle|cette référence|cette pièce))?/gi, par: '' },

  /* « …, paiement en 3× sans frais » en FIN de phrase : on retire la seule
     proposition, la phrase garde son début (« Échange standard sans caution »). */
  {
    regle: 'paiementFractionne',
    motif: /,\s*(?:et\s+)?paiement\s+(?:en\s+)?[34]\s?[x×](?:\s*(?:ou|\/)\s*[34]\s?[x×])?(?:\s+sans\s+frais)?(?:\s*\([^)]*\))?(?:\s+(?:via|avec)\s+Scalapay)?(?=\s*(?:[.!?;]|$))/gi,
    par: '',
  },
];

/* ─── Retraits au niveau de la phrase ─────────────────────────────────────── */

const PAIEMENT = [
  /\b[34]\s?[x×]\s*(?:ou\s+[34]\s?[x×]\s*)?(?:sans\s+frais|\()/i,
  /\b[34]\s?[x×]\s*\/\s*[34]\s?[x×](?![0-9])/i,
  /\bpaiements?\s+(?:en\s+)?[34]\s?[x×](?![0-9a-z])/i,
  /\b[34]\s+fois\s+sans\s+frais\b/i,
  /\bscalapay\b/i,
  /\b(?:payer|paiement|régler)\s+en\s+plusieurs\s+fois\b/i,
  /* Relevées dans les articles de blog (15/09/2026) : le montant s'intercale
     (« payable en 3 x 263 EUR sans frais »), ou le nombre de fois est écrit en
     toutes lettres après un mot de paiement. Un mot de PAIEMENT est exigé :
     « serrer en 3 fois » n'est pas une promesse. */
  /\b[34]\s?[x×]\s*\d[\d\s.,]*\s*(?:€|eur\b|euros?\b)\s*(?:ttc\s*)?sans\s+frais/i,
  /\b(?:paiements?|payer|régler|payable|réglable)\s+en\s+[34]\s+fois\b/i,
  /* Allemand : « in 3 Raten », « Ratenzahlung ». */
  /\b[34]\s+Raten\b/i,
  /\bRatenzahlung\b/i,
];

const NOMBRES = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, douze: 12, 'dix-huit': 18, 'vingt-quatre': 24, 'trente-six': 36,
};
const DUREE = /\b(\d{1,3}|une?|deux|trois|quatre|cinq|six|douze|dix-huit|vingt-quatre|trente-six)\s*(mois|ans?|années?)(?![a-zà-ÿ])/gi;
const MOT_GARANTIE = /garanti/gi;
/* Distance maximale entre « garanti… » et la durée : au-delà, la durée parle
   d'autre chose (« rodage à 3 mois », « modèles de 2 ans »). */
const PORTEE_GARANTIE = 45;

function contreditGarantie(segment, ctx) {
  if (!/garanti/i.test(segment)) return false;
  /* La garantie LÉGALE de conformité est de 2 ans par la loi : la citer n'est
     pas une promesse commerciale. */
  if (/garantie\s+l[ée]gale/i.test(segment)) return false;
  const positions = [];
  for (const m of segment.matchAll(MOT_GARANTIE)) positions.push(m.index);
  const durees = [];
  for (const m of segment.matchAll(DUREE)) {
    const proche = positions.some((p) => Math.abs(p - m.index) <= PORTEE_GARANTIE);
    if (!proche) continue;
    const brut = m[1].toLowerCase();
    const n = /^\d+$/.test(brut) ? Number(brut) : NOMBRES[brut];
    if (!n) continue;
    durees.push(/^mois$/i.test(m[2]) ? n : n * 12);
  }
  if (!durees.length) return false;
  /* Page qui regroupe plusieurs pièces : toute durée affichée est une
     garantie « en bloc » que la moitié des pièces ne tient pas. */
  if (ctx.portee === 'landing') return true;
  /* Fiche sans durée renseignée : rien à contredire (le badge et le texte
     viennent tous deux de la fiche). */
  if (!ctx.dureeGarantieMois) return false;
  return durees.some((d) => d !== ctx.dureeGarantieMois);
}

const RETRAITS = [
  /* Filet : toute mention d'ISO 9001 que les réécritures n'ont pas traitée —
     tournure inattendue, texte allemand (« ISO 9001-zertifizierten Werk »). */
  { regle: 'iso9001', teste: (s) => /ISO\s?-?\s?9001/i.test(s) },
  { regle: 'paiementFractionne', teste: (s) => PAIEMENT.some((rx) => rx.test(s)) },
  { regle: 'dureeGarantie', teste: (s, ctx) => contreditGarantie(s, ctx) },
];

/* ─── Mécanique texte / HTML ──────────────────────────────────────────────── */

/* Les balises sont remplacées par un caractère de la zone à usage privé
   Unicode le temps du travail sur le texte : une balise EN LIGNE (strong, a…)
   dans U+E000–U+EFFF, une balise de BLOC (p, li, br…) dans U+F000–U+F8FF.
   Le texte se découpe alors en phrases sans jamais couper une balise. */
const BALISE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^<>]*)?\/?>/g;
const BLOCS = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote', 'section', 'article', 'pre']);
const VIDES = new Set(['br', 'hr', 'img', 'wbr', 'input']);
const EN_LIGNE_MIN = 0xE000;
const EN_LIGNE_MAX = 0xEFFF;
const BLOC_MIN = 0xF000;
const BLOC_MAX = 0xF8FF;
const ZONE_PRIVEE = /[\uE000-\uF8FF]/;

function aplatir(html) {
  const balises = [];
  let enLigne = 0;
  let bloc = 0;
  let debordement = false;
  const texte = html.replace(BALISE, (brut, nom) => {
    const n = nom.toLowerCase();
    const info = { brut, nom: n, fermante: brut.charAt(1) === '/', vide: VIDES.has(n) || /\/>$/.test(brut) };
    const estBloc = BLOCS.has(n);
    const code = estBloc ? BLOC_MIN + bloc : EN_LIGNE_MIN + enLigne;
    if ((estBloc && code > BLOC_MAX) || (!estBloc && code > EN_LIGNE_MAX)) { debordement = true; return brut; }
    if (estBloc) bloc += 1; else enLigne += 1;
    balises[code] = info;
    return String.fromCharCode(code);
  });
  return { texte, balises, debordement };
}

function restaurer(texte, balises) {
  return texte.replace(/[\uE000-\uF8FF]/g, (c) => {
    const b = balises[c.charCodeAt(0)];
    return b ? b.brut : '';
  });
}

const ENTITES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', lt: '<', gt: '>', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê' };
/* Texte lisible d'un morceau aplati : sans balises, entités décodées — c'est
   sur lui que portent les tests, jamais sur le HTML brut. */
function lisible(morceau) {
  return morceau
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e.charAt(0) === '#') {
        const code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITES, e.toLowerCase()) ? ENTITES[e.toLowerCase()] : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/* Frontières de phrase : « . » « ! » « ? » suivis d'un blanc puis d'une
   MAJUSCULE (« réf. 0AM » n'en est pas une), et le séparateur « · » des listes
   compactes (« reconditionnée · garantie 24 mois · paiement 3x/4x »).
   Le point d'une ABRÉVIATION non plus : en allemand, le nom qui suit prend
   toujours la majuscule. « Für 1.390 € inkl. MwSt – in 3 Raten zahlbar – wird
   sie… » était coupé après « inkl. », et le retrait de la suite laissait
   « Für 1.390 € inkl. » seul dans 85 articles /de (mesuré le 15/09/2026). */
const ABREVIATIONS = ['[Ii]nkl', '[Zz]zgl', '[Ee]xkl', 'ca', 'bzw', 'evtl', 'ggf', 'vgl', 'Nr', '[Rr]éf', 'env', 'cf', '[zdu]', 'z\\.\\s?B', 'd\\.\\s?h', 'u\\.\\s?a'];
const SEPARATEUR = new RegExp(
  '\\s+·\\s+|(?<=[.!?…][\\uE000-\\uEFFF»"”’)]*)'
  + `(?<!(?:^|[^\\wÀ-ÿ])(?:${ABREVIATIONS.join('|')})\\.[\\uE000-\\uEFFF]*)`
  + '\\s+(?=[\\uE000-\\uEFFF]*[«"“(]?\\s?[A-ZÀ-ÖØ-ÞŒ])',
  'g'
);

function decouper(bloc) {
  const morceaux = [];
  let debut = 0;
  SEPARATEUR.lastIndex = 0;
  let m;
  while ((m = SEPARATEUR.exec(bloc)) !== null) {
    if (m[0].length === 0) { SEPARATEUR.lastIndex += 1; continue; }
    morceaux.push({ texte: bloc.slice(debut, m.index), sep: m[0] });
    debut = m.index + m[0].length;
  }
  morceaux.push({ texte: bloc.slice(debut), sep: '' });
  return morceaux;
}

/* Balises d'une phrase retirée qu'il faut GARDER pour que le HTML reste
   équilibré : fermantes dont l'ouvrante précède la phrase, ouvrantes dont la
   fermante la suit. Une paire complète disparaît avec la phrase. */
function balisesOrphelines(morceau, balises) {
  const pile = [];
  const fermantes = [];
  for (const c of morceau) {
    const code = c.charCodeAt(0);
    if (code < EN_LIGNE_MIN || code > EN_LIGNE_MAX) continue;
    const b = balises[code];
    if (!b || b.vide) continue;
    if (!b.fermante) { pile.push({ c, nom: b.nom }); continue; }
    if (pile.length && pile[pile.length - 1].nom === b.nom) pile.pop();
    else fermantes.push(c);
  }
  return fermantes.join('') + pile.map((p) => p.c).join('');
}

function aRetirer(morceau, ctx) {
  const t = lisible(morceau);
  if (!t) return false;
  return RETRAITS.some((r) => ctx.regles.has(r.regle) && r.teste(t, ctx));
}

function reecrire(texte, ctx) {
  let out = texte;
  for (const r of REECRITURES) {
    if (!ctx.regles.has(r.regle)) continue;
    r.motif.lastIndex = 0;
    out = out.replace(r.motif, r.par);
  }
  return out;
}

/* Blanc laissé par une expression retirée : « usine , » → « usine, ». */
function nettoyer(texte) {
  return texte
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*([.!?])/g, '$1');
}

const FIN = /[.!?…]\s*[\uE000-\uEFFF»"”’)]*\s*$/;

function filtrerBloc(bloc, ctx, balises) {
  const reecrit = reecrire(bloc, ctx);
  let modifie = reecrit !== bloc;
  const morceaux = decouper(reecrit);
  const garder = morceaux.map((m) => !aRetirer(m.texte, ctx));
  if (garder.some((g) => !g)) modifie = true;
  if (!modifie) return { texte: bloc, modifie: false };

  const dernierGarde = garder.lastIndexOf(true);
  /* Ponctuation qui terminait le bloc, si c'est un morceau retiré qui la
     portait : dans une liste « a · b · c. », elle revient sur « b ». */
  const dernier = morceaux[morceaux.length - 1];
  const finRetiree = garder[morceaux.length - 1] ? '' : ((lisible(dernier.texte).match(/[.!?…]$/) || [])[0] || '');

  let out = '';
  for (let i = 0; i < morceaux.length; i += 1) {
    const m = morceaux[i];
    if (!garder[i]) {
      out += balisesOrphelines(m.texte, balises);
      continue;
    }
    if (i === dernierGarde && i < morceaux.length - 1) {
      /* Dernier morceau gardé, suivi seulement de morceaux retirés : son
         séparateur n'a plus rien à séparer. */
      let t = m.texte;
      if (/·/.test(m.sep) && finRetiree && !FIN.test(t)) t = t.replace(/\s*$/, '') + finRetiree;
      out += t;
      continue;
    }
    out += m.texte + m.sep;
  }
  return { texte: nettoyer(out), modifie: true };
}

/**
 * Filtre un texte (brut, markdown ou HTML) selon le contexte.
 * Rend le texte INCHANGÉ si aucune règle ne s'applique.
 */
function filtrer(texte, ctx) {
  if (typeof texte !== 'string' || !texte || !ctx || !ctx.regles || !ctx.regles.size) return texte;

  /* Un texte contenant déjà des caractères de la zone privée ne peut pas être
     découpé sans ambiguïté : on se limite alors aux réécritures d'expression. */
  if (ZONE_PRIVEE.test(texte)) return nettoyerSiModifie(texte, reecrire(texte, ctx));

  const { texte: plat, balises, debordement } = aplatir(texte);
  if (debordement) return nettoyerSiModifie(texte, reecrire(texte, ctx));

  /* Blocs : balises de bloc et retours à la ligne. Les délimiteurs sont
     conservés tels quels (capture). */
  const parties = plat.split(/([\uF000-\uF8FF]|\n)/);
  let modifie = false;
  const LIGNE_VIDEE = '\u0000';
  for (let i = 0; i < parties.length; i += 2) {
    const avant = parties[i];
    if (!avant) continue;
    const r = filtrerBloc(avant, ctx, balises);
    if (!r.modifie) continue;
    modifie = true;
    /* Ligne de texte vidée (ou réduite à une puce markdown « - », « 1. ») :
       on la marque pour la supprimer avec son retour à la ligne. */
    const reste = r.texte.replace(/[\uE000-\uEFFF]/g, '').trim();
    parties[i] = (!reste || /^([-*+•]|\d+[.)]|#{1,6})$/.test(reste)) && !/[\uE000-\uEFFF]/.test(r.texte)
      ? LIGNE_VIDEE
      : r.texte;
  }
  if (!modifie) return texte;

  let plat2 = '';
  for (let i = 0; i < parties.length; i += 1) {
    if (parties[i] === LIGNE_VIDEE) {
      if (parties[i + 1] === '\n') i += 1; // la ligne part avec son saut de ligne
      continue;
    }
    plat2 += parties[i];
  }
  let out = restaurer(plat2, balises);
  /* Éléments vidés par un retrait (<p></p>, <li></li>, <strong></strong>). */
  let precedent;
  do {
    precedent = out;
    out = out.replace(/<(p|li|strong|em|b|i|u|span|h[2-4])(?:\s[^<>]*)?>\s*<\/\1>/gi, '');
  } while (out !== precedent);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function nettoyerSiModifie(avant, apres) {
  return apres === avant ? avant : nettoyer(apres);
}

/** Liste de textes courts (badges, points clés) : un élément vidé disparaît. */
function filtrerListe(liste, ctx) {
  if (!Array.isArray(liste)) return liste;
  return liste
    .map((v) => (typeof v === 'string' ? filtrer(v, ctx) : v))
    .filter((v) => typeof v !== 'string' || v.trim() !== '');
}

/** FAQ : une question ou une réponse vidée fait tomber l'entrée entière
 *  (elle alimente aussi le JSON-LD FAQPage). */
function filtrerFaqs(faqs, ctx) {
  if (!Array.isArray(faqs)) return faqs;
  return faqs
    .map((f) => (f && typeof f === 'object'
      ? { ...f, question: filtrer(f.question, ctx), answer: filtrer(f.answer, ctx) }
      : f))
    .filter((f) => f && typeof f.question === 'string' && f.question.trim() && typeof f.answer === 'string' && f.answer.trim());
}

/**
 * Copie de la fiche avec tous les textes AFFICHÉS filtrés : description,
 * description courte (qui sert de meta description et de description JSON-LD),
 * balises SEO, badges, garantie, FAQ, points clés, blocs d'information. Ne
 * mute pas l'original.
 */
function filtrerFiche(product, ctx) {
  if (!product || !ctx || !ctx.regles || !ctx.regles.size) return product;
  const out = { ...product };
  if (typeof out.description === 'string') out.description = filtrer(out.description, ctx);
  if (typeof out.shortDescription === 'string') out.shortDescription = filtrer(out.shortDescription, ctx);
  if (out.seo && typeof out.seo === 'object') {
    out.seo = {
      ...out.seo,
      metaTitle: filtrer(out.seo.metaTitle, ctx),
      metaDescription: filtrer(out.seo.metaDescription, ctx),
    };
  }
  if (out.badges && typeof out.badges === 'object') {
    out.badges = {
      ...out.badges,
      topLeft: filtrer(out.badges.topLeft, ctx),
      cards: filtrerListe(out.badges.cards, ctx),
    };
  }
  if (out.warranty && typeof out.warranty === 'object' && typeof out.warranty.text === 'string') {
    out.warranty = { ...out.warranty, text: filtrer(out.warranty.text, ctx) };
  }
  if (Array.isArray(out.keyPoints)) out.keyPoints = filtrerListe(out.keyPoints, ctx);
  if (Array.isArray(out.faqs)) out.faqs = filtrerFaqs(out.faqs, ctx);
  if (out.infoBlocksByPosition && typeof out.infoBlocksByPosition === 'object') {
    out.infoBlocksByPosition = filtrerBlocsInfo(out.infoBlocksByPosition, ctx);
  }
  return out;
}

/** Blocs d'information (InfoBlock, markdown rendu en HTML) attachés à la fiche.
 *  faf510d a remis à l'écran ceux de fin de description : un bloc partagé par
 *  des centaines de fiches (« Garantie : 1 an pièces et main d'œuvre ») ne doit
 *  pas contredire la garantie de CELLE-CI. Un bloc vidé disparaît. */
function filtrerBlocsInfo(groupes, ctx) {
  const visible = (html) => typeof html === 'string' && html.replace(/<[^>]*>/g, '').trim() !== '';
  const out = {};
  for (const [position, blocs] of Object.entries(groupes)) {
    out[position] = Array.isArray(blocs)
      ? blocs.flatMap((b) => {
        if (!b || typeof b !== 'object') return [b];
        const html = filtrer(b.html, ctx);
        /* Seul un bloc que le FILTRE a vidé disparaît ; un bloc déjà sans
           contenu reste tel que l'admin l'a voulu. */
        if (visible(b.html) && !visible(html)) return [];
        return [{ ...b, title: filtrer(b.title, ctx), html }];
      })
      : blocs;
  }
  return out;
}

/** Textes d'une page véhicule rédigés en base (VehicleLanding). */
function filtrerLanding(override, ctx) {
  if (!override || !ctx || !ctx.regles || !ctx.regles.size) return override;
  return {
    ...override,
    seoText: filtrer(override.seoText, ctx),
    metaTitle: filtrer(override.metaTitle, ctx),
    metaDescription: filtrer(override.metaDescription, ctx),
    h1Override: filtrer(override.h1Override, ctx),
  };
}

module.exports = {
  POLITIQUE,
  familleDuSku,
  reglesActives,
  contexteFiche,
  contexteLanding,
  contexteArticle,
  familleADescriptionMasquee,
  motifDescriptionMasquee,
  filtrer,
  filtrerListe,
  filtrerFaqs,
  filtrerBlocsInfo,
  filtrerFiche,
  filtrerLanding,
};
