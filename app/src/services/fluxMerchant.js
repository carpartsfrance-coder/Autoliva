'use strict';

/**
 * Règles communes des flux Google Merchant : français (/google-merchant-feed.xml)
 * et allemand (/google-merchant-feed-de.xml).
 *
 * ── Pourquoi (audit du 25/09/2026) ────────────────────────────────────────────
 *
 * Le flux français (13 362 articles) n'a jamais été soumis et le compte
 * Merchant Center n'a aucun produit approuvé. Soumis tel quel, il exposait le
 * compte à une suspension pour « présentation trompeuse » :
 *   - 6 327 copies mot pour mot du catalogue distrimotor.com (SKU DM-), sur des
 *     photos génériques partagées par des milliers de fiches ;
 *   - le service de clonage : Shopping n'accepte pas les services de réparation ;
 *   - aucun frais de port (obligatoire en France), des marques de repli
 *     (« Autoliva », « Multimarque », « VAG »), un MPN qui était le SKU interne,
 *     une seule catégorie Google (888, la racine « Véhicules et accessoires ») ;
 *   - des descriptions que la fiche ne sert plus (ISO 9001, « notre atelier »,
 *     ancien nom de la société) ;
 *   - des fiches « en stock » dont le délai est « confirmé à la commande ».
 *
 * Règle : un article n'entre dans un flux que s'il est exact et conforme. Dans
 * le doute il reste dehors, avec un motif compté et journalisé à chaque
 * construction — un flux court vaut mieux qu'un compte suspendu.
 *
 * Ce module ne lit pas la base : les routes chargent les fiches, ce module
 * décide et met en forme. Tout y est testé sans base (tests/unit/flux-merchant).
 */

const claimFilter = require('./claimFilter');
const { sanitizeBrandLeak } = require('./brandSanitizer');
const { extractMediaIdFromUrl, buildSeoMediaUrl } = require('./mediaStorage');
const { etatDepuisTexte, sansAccents } = require('./etatPiece');

const BASE = 'https://autoliva.com';

/* Une image principale présente sur plus de 3 fiches publiées est une photo
   générique (gabarit ALV-BX : 1 293 fiches ; turbos DM : 4 240). Jusqu'à 3,
   c'est une même pièce déclinée (phare gauche, droit, paire). */
const SEUIL_IMAGE_PARTAGEE = 3;

const TITRE_MAX = 150;
const DESCRIPTION_MAX = 5000;

/* ─── Motifs d'exclusion ─────────────────────────────────────────────────────
   Dans l'ordre où ils sont testés : un article exclu est compté sous son
   PREMIER motif (une copie DM- est comptée « copie_distrimotor », même si sa
   photo est aussi générique). */
const MOTIFS = [
  ['service_clonage', 'service de clonage : Shopping refuse les services de réparation'],
  ['copie_distrimotor', 'copie du catalogue distrimotor.com (SKU DM-)'],
  ['prix_invalide', 'prix nul ou absent'],
  ['sans_slug', 'pas d’adresse canonique (slug vide)'],
  ['sans_image', 'aucune image'],
  ['hors_stock', 'hors stock'],
  ['delai_non_garanti', 'délai « sur commande / sur demande / selon disponibilité / confirmé à la commande »'],
  ['consigne_encaissee', 'consigne encaissée à la commande en plus du prix, absente près du prix sur la fiche'],
  ['image_partagee', `image principale partagée par plus de ${SEUIL_IMAGE_PARTAGEE} fiches publiées`],
  ['etat_indetermine', 'état (neuf, reconditionné, occasion) impossible à établir'],
  ['etat_contradictoire', 'état contredit par le titre, l’adresse ou la description'],
  ['titre_generique', 'titre sans marque ni modèle de véhicule, ni référence'],
  ['titre_duplique', 'titre porté par un autre article du flux'],
];
const MOTIF = Object.freeze(Object.fromEntries(MOTIFS.map(([code]) => [code.toUpperCase(), code])));
const LIBELLE_MOTIF = Object.freeze(Object.fromEntries(MOTIFS));

/* ─── Outils texte ────────────────────────────────────────────────────────── */

function normaliser(value) {
  return sansAccents(value).toLowerCase();
}

function compacter(value) {
  return normaliser(value).replace(/[^a-z0-9]/g, '');
}

function echapperRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniques(liste) {
  return [...new Set(liste)];
}

const ENTITES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—', euro: '€', deg: '°', eacute: 'é', egrave: 'è',
  ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', icirc: 'î', iuml: 'ï', euml: 'ë',
};

function decoderEntites(texte) {
  return texte.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e.charAt(0) === '#') {
      const code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
    }
    const cle = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITES, cle) ? ENTITES[cle] : m;
  });
}

/**
 * Texte lisible d'une description stockée (HTML ou markdown) : ce que le
 * visiteur lit dans le bloc « Description », sans balise ni syntaxe markdown.
 * Paragraphes et puces sont gardés en lignes (Merchant accepte le texte brut
 * avec retours à la ligne, pas le HTML).
 */
function texteBrut(valeur) {
  if (typeof valeur !== 'string' || !valeur.trim()) return '';
  let s = valeur;
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  s = s.replace(/\r\n?/g, '\n').replace(/^\s*•\s+/gm, '- ');
  if (/<\/?[a-z][\s\S]*>/i.test(s)) {
    s = s
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|section|article)>/gi, '\n')
      /* Balises en ligne : retirées sans blanc (« <strong>x</strong>. » → « x. »). */
      .replace(/<\/?(?:a|strong|b|em|i|u|span|small|sup|sub|mark|abbr|code)\b[^>]*>/gi, '')
      .replace(/<[^>]*>/g, ' ');
  } else {
    s = s
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[*+]\s+/gm, '- ');
  }
  return decoderEntites(s)
    .split('\n')
    .map((ligne) => ligne.replace(/[ \t\u00a0\u202f]+/g, ' ').trim())
    .filter((ligne) => ligne && ligne !== '-')
    .join('\n');
}

function tronquer(texte, max) {
  const s = String(texte || '').trim();
  if (s.length <= max) return s;
  const coupe = s.slice(0, max - 1);
  const espace = coupe.lastIndexOf(' ');
  return `${(espace > max * 0.6 ? coupe.slice(0, espace) : coupe).replace(/[\s,;:–—|·-]+$/, '')}…`;
}

/* ─── Images ──────────────────────────────────────────────────────────────── */

/** Images d'une fiche telle qu'en base : image principale puis galerie
 *  (les vidéos de la galerie sont écartées). */
function imagesDeLaFiche(doc) {
  const out = [];
  if (doc && typeof doc.imageUrl === 'string' && doc.imageUrl.trim()) out.push(doc.imageUrl.trim());
  if (doc && Array.isArray(doc.galleryUrls)) {
    const types = Array.isArray(doc.galleryTypes) ? doc.galleryTypes : [];
    doc.galleryUrls.forEach((u, i) => {
      if (typeof u === 'string' && u.trim() && (types[i] || 'image') === 'image') out.push(u.trim());
    });
  }
  return out;
}

/** Identité d'une image : l'identifiant du média (/media/<id> et
 *  /media/<slug>-<id>.jpeg sont la même image), sinon l'adresse. */
function cleImage(url) {
  const id = extractMediaIdFromUrl(url);
  if (id) return `media:${String(id)}`;
  return String(url || '').trim().toLowerCase().replace(/[?#].*$/, '');
}

/** Nombre de fiches publiées qui utilisent chaque image (principale ou galerie),
 *  calculé UNE fois par construction. Compté par identifiant de média : deux
 *  copies d'une même photo téléversées séparément ne sont pas rapprochées. */
function compterUsagesImages(docs) {
  const usages = new Map();
  for (const doc of Array.isArray(docs) ? docs : []) {
    for (const cle of new Set(imagesDeLaFiche(doc).map(cleImage).filter(Boolean))) {
      usages.set(cle, (usages.get(cle) || 0) + 1);
    }
  }
  return usages;
}

function urlAbsolueImage(chemin) {
  if (!chemin) return null;
  if (/^https?:\/\//i.test(chemin)) return chemin;
  const p = chemin.startsWith('/') ? chemin : `/${chemin}`;
  return `${BASE}${p}${/\.(jpe?g|png|gif|webp)$/i.test(p) ? '' : '.jpeg'}`;
}

/** Adresses d'images du flux (principale + 10 au plus), sans doublon. */
function imagesPourFlux(images, libelle) {
  const vues = new Set();
  const out = [];
  for (const brut of images) {
    const cle = cleImage(brut);
    if (!cle || vues.has(cle)) continue;
    vues.add(cle);
    out.push(urlAbsolueImage(buildSeoMediaUrl(brut, libelle) || brut));
    if (out.length === 11) break;
  }
  return out.filter(Boolean);
}

/* ─── État ────────────────────────────────────────────────────────────────── */

/* « reconditionneur » désigne l'entreprise (« notre partenaire
   reconditionneur », écrit par le filtre des allégations), pas l'état de la
   pièce. */
const RX_RECONDITIONNE = /(recondition(?!neu[rs])|refurb|remanufact|echange[\s-]+standard)/;
const RX_OCCASION = /\boccasion\b/;

/** « neuf » qui qualifie la pièce — pas « remis à neuf », « comme neuf »,
 *  « état neuf ». Texte normalisé attendu. */
function mentionNeuf(n) {
  const rx = /\bneu(?:f|ve)s?\b/g;
  let m;
  while ((m = rx.exec(n)) !== null) {
    if (/(?:\ba|\bcomme|\betat|\bremise?\s+a)\s*$/.test(n.slice(Math.max(0, m.index - 14), m.index))) continue;
    return true;
  }
  return false;
}

/** Titre (H1) et adresse de la fiche, normalisés. */
function titreEtAdresse(fiche) {
  return normaliser(`${fiche.name || ''} ${String(fiche.slug || '').replace(/-/g, ' ')}`);
}

/** État AFFICHÉ par la fiche : caractéristique « État », sinon badge d'état —
 *  la source de l'itemCondition du JSON-LD (productController). */
function texteEtatAffiche(fiche) {
  for (const s of Array.isArray(fiche.specs) ? fiche.specs : []) {
    const cle = normaliser(s && s.label).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (cle !== 'etat') continue;
    const valeur = typeof s.value === 'string' ? s.value.trim() : '';
    if (valeur) return valeur;
    break;
  }
  return fiche.badges && typeof fiche.badges.condition === 'string' ? fiche.badges.condition.trim() : '';
}

/**
 * État Merchant d'une fiche : 'new' | 'refurbished' | 'used' | null.
 *   1. l'état affiché (caractéristique « État » ou badge), lu comme le JSON-LD ;
 *   2. sinon le titre et l'adresse, s'ils ne désignent qu'UN état ;
 *   3. sinon null — l'ancien flux supposait « reconditionné » : l'article est
 *      désormais exclu (etat_indetermine).
 */
function etatDuProduit(fiche) {
  const affiche = etatDepuisTexte(texteEtatAffiche(fiche));
  if (affiche) return affiche;
  const n = titreEtAdresse(fiche);
  const trouves = new Set();
  if (RX_RECONDITIONNE.test(n)) trouves.add('refurbished');
  if (RX_OCCASION.test(n)) trouves.add('used');
  if (mentionNeuf(n)) trouves.add('new');
  return trouves.size === 1 ? [...trouves][0] : null;
}

const RX_NEGATION = /\b(contrairement|aucune?|pas|ni|sans|plutot|au lieu|non|jamais)\b/;

/** Le texte dit-il « reconditionné / échange standard / occasion » de la pièce ?
 *  Une mention niée dans sa proposition (« contrairement à nos blocs en échange
 *  standard », « aucune pièce d'occasion ») ne compte pas. */
function mentionEtatUsage(texte) {
  const plat = normaliser(texteBrut(texte));
  for (const proposition of plat.split(/[.;:!?\n,()«»"“”]+/)) {
    const rx = /(recondition(?!neu[rs])|remanufact|echange\s+standard|occasion)/g;
    let m;
    while ((m = rx.exec(proposition)) !== null) {
      if (!RX_NEGATION.test(proposition.slice(0, m.index))) return true;
    }
  }
  return false;
}

/**
 * L'état retenu est-il contredit par ce que la fiche affiche ?
 *   - neuf : le titre, l'adresse ou la description disent « reconditionné »,
 *     « échange standard » ou « occasion » ;
 *   - reconditionné : le titre ou l'adresse disent « occasion » ou « neuf » sans
 *     jamais dire « reconditionné » ;
 *   - occasion : le titre ou l'adresse disent « reconditionné » ou « neuf » sans
 *     dire « occasion ».
 * Les descriptions ne comptent que pour « neuf » : ailleurs elles comparent
 * volontiers au neuf (« 40 % moins cher que le neuf »).
 */
function etatContradictoire(etat, fiche) {
  const n = titreEtAdresse(fiche);
  const recond = RX_RECONDITIONNE.test(n);
  const occasion = RX_OCCASION.test(n);
  const neuf = mentionNeuf(n);
  if (etat === 'new') return recond || occasion || mentionEtatUsage(fiche.description) || mentionEtatUsage(fiche.shortDescription);
  if (etat === 'refurbished') return !recond && (occasion || neuf);
  if (etat === 'used') return !occasion && (recond || neuf);
  return false;
}

/* ─── Disponibilité et prix ───────────────────────────────────────────────── */

/* Délais qui n'engagent à rien : Google interdit d'annoncer « en stock » ce
   qu'on ne peut pas expédier (texte normalisé, sans accents). Les tournures
   allemandes couvrent le texte traduit de la fiche /de. */
const RX_DELAI_NON_GARANTI = [
  /\bsur\s+(?:commande|demande)\b/,
  /\bselon\s+(?:la\s+|les\s+)?disponibilites?\b/,
  /\bselon\s+(?:le\s+|les\s+|l'\s*|l’\s*)?(?:stocks?|arrivages?|approvisionnements?)\b/,
  /\bconfirme\w*\s+(?:a|apres|lors\s+de|des)\s+(?:la\s+)?commande\b/,
  /\ba\s+confirmer\b/,
  /\b(?:nous\s+consulter|nous\s+contacter|contactez[\s-]nous)\b/,
  /\bauf\s+(?:anfrage|bestellung)\b/,
  /\b(?:nach|je\s+nach)\s+verfugbarkeit\b/,
  /\bje\s+nach\s+lager/,
  /\bbei\s+(?:der\s+)?bestellung\s+bestatigt\b/,
];

function delaiNonGaranti(...textes) {
  return textes.some((t) => {
    const n = normaliser(t);
    return n.trim() !== '' && RX_DELAI_NON_GARANTI.some((rx) => rx.test(n));
  });
}

/** Consigne ENCAISSÉE à la commande en plus du prix affiché (mêmes conditions
 *  que la fiche : consigne active, montant > 0, « Encaisser la caution »). La
 *  consigne facturée seulement si l'ancienne pièce ne revient pas ne s'ajoute
 *  pas au paiement : elle n'exclut pas. */
function consigneEncaissee(fiche) {
  const c = fiche && fiche.consigne;
  return !!(c && c.enabled === true && c.chargeUpfront === true && Number(c.amountCents) > 0);
}

function slugValide(fiche) {
  return typeof fiche.slug === 'string' && fiche.slug.trim() !== '';
}

/* ─── Titre ───────────────────────────────────────────────────────────────── */

const SEPARATEURS_TITRE = /(\s+[–—|·]\s+|\s+-\s+)/;
/* « – Garantie 2 ans », « … garantie 24 mois », « avec garantie » : Google
   refuse le texte promotionnel dans les titres. La garantie reste dite par la
   fiche et par la description. */
const RX_SEGMENT_GARANTIE = /^(?:avec\s+|et\s+|mit\s+)?garantie(?:\s+(?:de\s+|von\s+)?\d+\s*(?:ans?|mois|jahre?n?|monate?n?))?$/i;
const RX_GARANTIE_EN_FIN = /[\s,]+(?:avec\s+|et\s+|mit\s+)?garantie(?:\s+(?:de\s+|von\s+)?\d+\s*(?:ans?|mois|jahre?n?|monate?n?))?\s*$/i;

/**
 * Titre du flux : le nom de la fiche (le H1), avec les mêmes filtres que la
 * fiche applique à ses textes — ancien nom de marque (sanitizeBrandLeak) et
 * allégations non prouvées (claimFilter) —, sans texte promotionnel, 150
 * caractères au plus. Le travail se fait segment par segment (« … – … ») :
 * sur un titre, retirer « la phrase » qui porte une allégation le viderait.
 * Un titre vidé est exclu du flux (titre_generique).
 */
function titreDuFlux(nom, ctx) {
  const parties = sanitizeBrandLeak(String(nom || '').replace(/\s+/g, ' ').trim()).split(SEPARATEURS_TITRE);
  const gardees = [];
  for (let i = 0; i < parties.length; i += 2) {
    let segment = parties[i].replace(RX_GARANTIE_EN_FIN, '').trim();
    if (RX_SEGMENT_GARANTIE.test(segment)) segment = '';
    if (segment && ctx && ctx.regles && ctx.regles.size) segment = String(claimFilter.filtrer(segment, ctx) || '').trim();
    if (segment) gardees.push({ segment, separateur: parties[i - 1] || ' ' });
  }
  const titre = gardees
    .map((g, i) => (i ? g.separateur : '') + g.segment)
    .join('')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s–—|·,-]+|[\s–—|·,-]+$/g, '');
  if (titre.length <= TITRE_MAX) return titre;
  const coupe = titre.slice(0, TITRE_MAX);
  const espace = coupe.lastIndexOf(' ');
  return (espace > 80 ? coupe.slice(0, espace) : coupe).replace(/[\s–—|·,-]+$/, '');
}

/** Clé de comparaison des titres (doublons) : casse, accents, ponctuation ignorés. */
function cleTitre(titre) {
  return normaliser(titre).replace(/[^a-z0-9]+/g, ' ').trim();
}

/* Constructeurs automobiles (et groupes) reconnus dans un titre. */
const MARQUES_VEHICULES = [
  'abarth', 'acura', 'alfa romeo', 'alpine', 'aston martin', 'audi', 'bentley', 'bmw', 'buick', 'byd', 'cadillac',
  'chevrolet', 'chrysler', 'citroen', 'cupra', 'dacia', 'daewoo', 'daf', 'daihatsu', 'dodge', 'ds', 'ferrari', 'fiat',
  'ford', 'geely', 'genesis', 'gmc', 'honda', 'hummer', 'hyundai', 'infiniti', 'isuzu', 'iveco', 'jaguar', 'jeep',
  'kia', 'lada', 'lamborghini', 'lancia', 'land rover', 'range rover', 'lexus', 'lincoln', 'lotus', 'man', 'maserati',
  'mazda', 'mclaren', 'mercedes', 'mercedes benz', 'mg', 'mini', 'mitsubishi', 'nissan', 'opel', 'peugeot', 'polestar',
  'pontiac', 'porsche', 'renault', 'rolls royce', 'rover', 'saab', 'santana', 'scania', 'seat', 'skoda', 'smart',
  'ssangyong', 'subaru', 'suzuki', 'tesla', 'toyota', 'vauxhall', 'volkswagen', 'vw', 'volvo', 'vag', 'psa',
];
const RX_MARQUE_VEHICULE = new RegExp(`\\b(?:${MARQUES_VEHICULES.map((m) => echapperRegex(m).replace(/ /g, '[\\s-]+')).join('|')})\\b`);
/* « 130ch », « 16v », « 2.0l », « 4x4 » : des caractéristiques, pas des références. */
const RX_UNITE = /^\d+(?:[.,]\d+)?(?:ch|cv|kw|hp|ps|v|l|mm|cm3|cc|nm|km|kg|ans?|mois|h|t)$/;
/* Sigles en capitales qui ne sont PAS des codes moteur ou boîte. */
const SIGLES_COURANTS = new Set([
  'TDI', 'TSI', 'TFSI', 'FSI', 'HDI', 'DCI', 'CDI', 'CDTI', 'CRDI', 'JTD', 'JTDM', 'TDCI', 'GTI', 'GTD', 'GTE', 'GTS',
  'GTR', 'AMG', 'DSG', 'BVA', 'BVM', 'BVR', 'EAT', 'EDC', 'CVT', 'AWD', 'FWD', 'RWD', 'LED', 'ABS', 'ESP', 'TCU',
  'ECU', 'TCM', 'PDLS', 'AHL', 'THP', 'VTI', 'GDI', 'MPI', 'TCE', 'DIG', 'SCE', 'GPL', 'GNV', 'LPG', 'CNG', 'PHEV',
  'MHEV', 'HEV', 'OEM', 'ATC', 'ISM', 'PCM', 'LCI', 'SUV', 'VAN', 'NEUF', 'NEUVE', 'ECO', 'TDS', 'SDI', 'TDV', 'SDV',
  'DOHC', 'SOHC', 'VVT', 'VTEC', 'IDI', 'HPI', 'HSE', 'SRT', 'SVR', 'RSI', 'EURO', 'KIT', 'DPF', 'FAP', 'EGR', 'VIN',
  'TTC', 'AVEC', 'POUR', 'SANS', 'TRES', 'ETAT', 'PACK', 'BLUE', 'PURE', 'TECH', 'TURBO', 'III', 'VII', 'VIII', 'XII',
  'NEW', 'USED', 'THE', 'AND', 'LES', 'DES', 'UNE', 'NOS', 'VOS',
]);

/** Code moteur ou boîte écrit en capitales (« — FYA », « TLE », « CAVE »),
 *  hors sigles courants. Un titre écrit tout en capitales ne compte pas. */
function codeEnCapitales(titre) {
  const lettres = String(titre).replace(/[^\p{L}]/gu, '');
  const capitales = String(titre).replace(/[^\p{Lu}]/gu, '');
  if (!lettres || capitales.length / lettres.length > 0.5) return false;
  return String(titre)
    .split(/[\s,;:()[\]/–—|·"«»]+/)
    .map((brut) => brut.replace(/^[.'’-]+|[.'’-]+$/g, ''))
    .some((jeton) => /^[A-Z]{3,5}$/.test(jeton) && !SIGLES_COURANTS.has(jeton));
}

/**
 * Titre générique : ni constructeur ni modèle de véhicule, ni référence de
 * pièce, de moteur ou de boîte (« Turbo reconditionné – échange standard »).
 * Une référence, c'est le code moteur ou une référence compatible de la fiche
 * présents dans le titre, un code en capitales (« FYA »), ou un jeton
 * lettres + chiffres (« DQ200 », « 0AM325065 ») ou d'au moins 5 chiffres.
 */
function titreGenerique(titre, fiche) {
  const n = normaliser(titre);
  if (!n.trim()) return true;
  if (RX_MARQUE_VEHICULE.test(n)) return false;
  if (codeEnCapitales(titre)) return false;
  for (const c of Array.isArray(fiche.compatibility) ? fiche.compatibility : []) {
    for (const v of [c && c.make, c && c.model]) {
      const k = normaliser(v).trim();
      if (k.length >= 2 && new RegExp(`\\b${echapperRegex(k)}\\b`).test(n)) return false;
    }
  }
  const titreCompact = compacter(titre);
  for (const r of [fiche.engineCode, ...(Array.isArray(fiche.compatibleReferences) ? fiche.compatibleReferences : [])]) {
    const k = compacter(r);
    if (k.length >= 3 && titreCompact.includes(k)) return false;
  }
  for (const brut of n.split(/[\s,;:()[\]/–—|·"«»]+/)) {
    const jeton = brut.replace(/^[.'’-]+|[.'’-]+$/g, '');
    if (!jeton || RX_UNITE.test(jeton)) continue;
    const k = jeton.replace(/[.'’-]/g, '');
    if (k.length >= 4 && /\d/.test(k) && /[a-z]/.test(k)) return false;
    if (/^\d{5,}$/.test(k)) return false;
  }
  return true;
}

/* ─── Description ─────────────────────────────────────────────────────────── */

const LIBELLES = {
  fr: { etat: 'État', compat: 'Compatible avec', refs: 'Références', deuxPoints: ' : ', new: 'neuf', refurbished: 'reconditionné', used: 'occasion' },
  de: { etat: 'Zustand', compat: 'Passend für', refs: 'Referenzen', deuxPoints: ': ', new: 'neu', refurbished: 'generalüberholt', used: 'gebraucht' },
};

/** Description factuelle, faite de ce que la fiche affiche déjà (titre, état,
 *  véhicules, références) : quand aucun texte stocké ne peut être publié. */
function descriptionFactuelle(fiche, { titre, etat, lang }) {
  const l = LIBELLES[lang === 'de' ? 'de' : 'fr'];
  const morceaux = [`${String(titre || '').replace(/[.\s]+$/, '')}.`];
  if (etat && l[etat]) morceaux.push(`${l.etat}${l.deuxPoints}${l[etat]}.`);
  const vehicules = uniques((Array.isArray(fiche.compatibility) ? fiche.compatibility : [])
    .map((c) => [c && c.make, c && c.model].filter(Boolean).join(' ').trim())
    .filter(Boolean)).slice(0, 6);
  if (vehicules.length) morceaux.push(`${l.compat}${l.deuxPoints}${vehicules.join(', ')}.`);
  const refs = uniques([fiche.engineCode, ...(Array.isArray(fiche.compatibleReferences) ? fiche.compatibleReferences : [])]
    .map((r) => String(r || '').trim())
    .filter(Boolean)).slice(0, 8);
  if (refs.length) morceaux.push(`${l.refs}${l.deuxPoints}${refs.join(', ')}.`);
  return morceaux.join(' ');
}

/**
 * Description du flux, décidée comme le bloc « Description » de la fiche :
 *   - la fiche l'affiche (motifDescriptionMasquee = null) → la description
 *     (ou, à défaut, la description courte) déjà passée par le filtre des
 *     allégations, en texte brut ;
 *   - famille dont le texte n'est JAMAIS servi (DM-, voir claims-policy.json) →
 *     aucun texte stocké : description factuelle ;
 *   - bloc coupé pour une autre raison (langue allemande, interrupteur
 *     SHOW_PRODUCT_DESCRIPTION=off) → la description courte, que la fiche sert
 *     encore en meta description ; à défaut, la description factuelle.
 * `description` et `courte` sont les textes de la langue servie, déjà filtrés.
 */
function descriptionDuFlux({ fiche, description, courte, lang, titre, etat }) {
  const motif = claimFilter.motifDescriptionMasquee(fiche, { lang });
  const familleMasquee = claimFilter.familleADescriptionMasquee(fiche);
  let texte = '';
  if (!motif) texte = texteBrut(sanitizeBrandLeak(description || courte || ''));
  else if (!familleMasquee) texte = texteBrut(sanitizeBrandLeak(courte || ''));
  if (!texte) texte = descriptionFactuelle(fiche, { titre, etat, lang });
  return tronquer(texte, DESCRIPTION_MAX);
}

/* ─── Marque ──────────────────────────────────────────────────────────────── */

/* Familles dont la marque saisie est celle du VÉHICULE, pas du fabricant de la
   pièce : turbos, pompes et injecteurs DM (Garrett, Bosch… vendus sous
   « Opel »), pièces Alibaba refaites en usine en Chine. Google : ne pas donner
   la marque d'origine d'une pièce compatible ; dans le doute, pas de marque. */
const FAMILLES_MARQUE_NON_FIABLE = new Set(['DM', 'ALIBABA']);

const MARQUES = {
  abarth: 'Abarth', acura: 'Acura', 'alfa romeo': 'Alfa Romeo', alfa: 'Alfa Romeo', alpine: 'Alpine',
  'aston martin': 'Aston Martin', audi: 'Audi', bentley: 'Bentley', bmw: 'BMW', buick: 'Buick', byd: 'BYD',
  cadillac: 'Cadillac', chevrolet: 'Chevrolet', chrysler: 'Chrysler', citroen: 'Citroën', cupra: 'Cupra',
  dacia: 'Dacia', daewoo: 'Daewoo', daf: 'DAF', daihatsu: 'Daihatsu', dodge: 'Dodge', ds: 'DS', ferrari: 'Ferrari',
  fiat: 'Fiat', ford: 'Ford', geely: 'Geely', genesis: 'Genesis', gm: 'GM', 'general motors': 'GM', gmc: 'GMC',
  honda: 'Honda', hummer: 'Hummer', hyundai: 'Hyundai', infiniti: 'Infiniti', infinity: 'Infiniti', isuzu: 'Isuzu',
  iveco: 'Iveco', jaguar: 'Jaguar', jeep: 'Jeep', kia: 'Kia', lada: 'Lada', lamborghini: 'Lamborghini',
  lancia: 'Lancia', 'land rover': 'Land Rover', 'range rover': 'Land Rover', lexus: 'Lexus', lincoln: 'Lincoln',
  lotus: 'Lotus', man: 'MAN', maserati: 'Maserati', mazda: 'Mazda', mclaren: 'McLaren', mercedes: 'Mercedes-Benz',
  'mercedes benz': 'Mercedes-Benz', mg: 'MG', mini: 'MINI', mitsubishi: 'Mitsubishi', nissan: 'Nissan',
  opel: 'Opel', peugeot: 'Peugeot', polestar: 'Polestar', porsche: 'Porsche', porche: 'Porsche', renault: 'Renault',
  'rolls royce': 'Rolls-Royce', rover: 'Rover', saab: 'Saab', santana: 'Santana', seat: 'SEAT', skoda: 'Škoda',
  smart: 'smart', ssangyong: 'SsangYong', subaru: 'Subaru', suzuki: 'Suzuki', tesla: 'Tesla', toyota: 'Toyota',
  vauxhall: 'Vauxhall', volkswagen: 'Volkswagen', vw: 'Volkswagen', volvo: 'Volvo',
  /* Équipementiers : fabricants réels de mécatroniques, calculateurs, kits. */
  aisin: 'Aisin', borgwarner: 'BorgWarner', bosch: 'Bosch', continental: 'Continental', delphi: 'Delphi',
  denso: 'Denso', garrett: 'Garrett', getrag: 'Getrag', gkn: 'GKN', haldex: 'Haldex', hella: 'Hella', jatco: 'Jatco',
  luk: 'LuK', mahle: 'Mahle', 'magneti marelli': 'Magneti Marelli', sachs: 'Sachs', siemens: 'Siemens',
  temic: 'Temic', valeo: 'Valeo', zf: 'ZF',
};

/* Valeurs qui ne sont pas une marque : la boutique, un fournisseur, un groupe,
   une absence de marque. */
const PAS_UNE_MARQUE = new Set([
  'autoliva', 'car parts france', 'carparts france', 'carpartsfrance', 'cpf', 'distrimotor', 'multimarque',
  'multimarques', 'multi marque', 'multi marques', 'toutes marques', 'vag', 'groupe vag', 'vag group', 'psa',
  'groupe psa', 'stellantis', 'volkswagen audi group', 'volkswagen group', 'generique', 'universel', 'universelle',
  'origine', 'oem', 'oe', 'autre', 'autres', 'divers', 'inconnu', 'inconnue', 'na', 'n a', 'aucune',
]);
const RX_PAS_UNE_MARQUE = /\b(piece|pieces|reconditionn\w*|origine|occasion|neu(?:f|ve)|compatible|adaptable|generique|universel\w*|echange)\b/;

function cleMarque(v) {
  return normaliser(v).replace(/[-_.'’]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Une valeur de marque → forme canonique, ou null si ce n'est pas une marque. */
function normaliserMarque(valeur) {
  const brut = String(valeur || '').replace(/\s+/g, ' ').trim();
  const cle = cleMarque(brut);
  if (!cle || PAS_UNE_MARQUE.has(cle) || RX_PAS_UNE_MARQUE.test(cle)) return null;
  if (MARQUES[cle]) return MARQUES[cle];
  /* « Mitsubishi Montero », « Volkswagen Audi Seat Skoda » : marque connue en tête. */
  const mots = cle.split(' ');
  for (let n = Math.min(3, mots.length - 1); n >= 1; n -= 1) {
    const tete = mots.slice(0, n).join(' ');
    if (PAS_UNE_MARQUE.has(tete)) return null;
    if (MARQUES[tete]) return MARQUES[tete];
  }
  /* Marque inconnue de la table : gardée telle que saisie, capitales
     d'emphase ramenées à une casse normale (« BORGWARNER » → « Borgwarner »). */
  if (brut === brut.toUpperCase() && /\p{Lu}{5,}/u.test(brut)) {
    return brut.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, avant, lettre) => avant + lettre.toUpperCase());
  }
  return brut;
}

/**
 * Marque Google : celle de la fiche, normalisée (« AUDI » → « Audi »,
 * « Mercedes » → « Mercedes-Benz »), la première d'une liste (« Renault /
 * Nissan » → « Renault »). Jamais de repli sur le nom de la boutique ni sur
 * une valeur vide de sens : sans marque sûre, pas de balise (autorisé pour une
 * pièce d'occasion ou reconditionnée).
 */
function marqueGoogle(fiche) {
  if (FAMILLES_MARQUE_NON_FIABLE.has(claimFilter.familleDuSku(fiche && fiche.sku))) return null;
  const brut = String((fiche && fiche.brand) || '').trim();
  if (!brut) return null;
  const premiere = brut.split(/\s*(?:\/|,|&|\+|;|\|)\s*|\s+et\s+/i).map((s) => s.trim()).filter(Boolean)[0];
  return premiere ? normaliserMarque(premiere) : null;
}

/* ─── Identifiants ────────────────────────────────────────────────────────── */

/* Libellés de caractéristique qui désignent la référence du FABRICANT. Pas
   « Référence » seul : sur la fiche, c'est le SKU interne. */
const RX_LIBELLE_REF_FABRICANT = /^(?:ref(?:erence)?s?\.?\s*(?:du\s+|de\s+la\s+|d\s*)?(?:fabricant|constructeur|oem|oe|origine|piece)|numero\s+(?:de\s+)?piece|n[o°]?\s*(?:de\s+)?piece|part\s*number|mpn|oem)$/;
const PREFIXES_INTERNES = /^(?:dm|asy|alv|dek|edn|auto|vege|wc|occ|pont|neuf|cpf)[-_]/i;

/** Une référence unique, en forme de numéro de pièce : 6 à 25 caractères,
 *  au moins 5 chiffres (écarte « YS23DDTT », « 20DP25 », « M48.02 », codes
 *  moteur ou boîte qui ne sont pas des références de pièce). */
function formeDeReference(valeur) {
  const v = String(valeur || '').trim();
  if (!v || /[,;/|]/.test(v)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{4,24}$/.test(v)) return false;
  if (/^[0-9a-f]{24}$/i.test(v) || PREFIXES_INTERNES.test(v)) return false;
  return (v.match(/\d/g) || []).length >= 5;
}

/**
 * MPN fiable, ou null. Sources retenues, dans l'ordre :
 *   1. une caractéristique « Référence fabricant / constructeur / OEM /
 *      d'origine », « Numéro de pièce », « Part number », « MPN » portant UNE
 *      référence ;
 *   2. la seule référence compatible de la fiche, quand le titre la cite.
 * Jamais le SKU (interne), l'_id Mongo ni le code moteur ; jamais sans marque
 * (Google identifie une pièce par le couple marque + MPN) ; jamais d'EAN
 * inventé.
 */
function mpnFiable(fiche, marque) {
  if (!marque) return null;
  for (const s of Array.isArray(fiche.specs) ? fiche.specs : []) {
    const libelle = cleMarque(s && s.label);
    if (!RX_LIBELLE_REF_FABRICANT.test(libelle)) continue;
    const valeur = String((s && s.value) || '').trim();
    if (formeDeReference(valeur)) return valeur;
  }
  const refs = (Array.isArray(fiche.compatibleReferences) ? fiche.compatibleReferences : [])
    .map((r) => String(r || '').trim())
    .filter(Boolean);
  if (refs.length === 1 && formeDeReference(refs[0]) && compacter(fiche.name).includes(compacter(refs[0]))) return refs[0];
  return null;
}

/* ─── Catégorie Google ────────────────────────────────────────────────────── */

/* Taxonomie officielle Google (taxonomy-with-ids.fr-FR.txt, version 2021-09-21),
   lignes retenues :
     5613 - Véhicules et accessoires > Pièces détachées pour véhicules
      899 - … > Pièces détachées pour véhicules > Pièces détachées automobiles et motos
     8137 - … > Pièces détachées automobiles et motos > Moteurs de véhicules
     2641 - … > Pièces détachées automobiles et motos > Pièces de transmission pour véhicules
     2820 - … > Pièces détachées automobiles et motos > Pièces moteur
     2727 - … > Pièces détachées automobiles et motos > Systèmes d'alimentation en carburant
     3318 - … > Pièces détachées automobiles et motos > Éclairage de véhicule
     8231 - … > Pièces détachées automobiles et motos > Systèmes d'alimentation pour véhicules
     8234 - … > Pièces détachées automobiles et motos > Capteurs et jauges
     2977 - … > Pièces détachées automobiles et motos > Système de freinage
     2935 - … > Pièces détachées automobiles et motos > Pièces de suspension pour véhicules
     8227 - … > Pièces détachées automobiles et motos > Pièces de châssis et carrosserie
     2642 - … > Pièces détachées automobiles et motos > Rétroviseurs
     2534 - … > Pièces détachées automobiles et motos > Pièces et accessoires pour fenêtres de véhicules
     8233 - … > Pièces détachées automobiles et motos > Équipements intérieurs de véhicules
     8526 - … > Pièces détachées pour véhicules > Électronique pour véhicules
     2879 - … > Sécurité des véhicules > Équipement de sécurité des véhicules
     2788 - … > Entretien et décoration de véhicules > Liquides pour véhicules
   L'ancien flux envoyait 888 (« Véhicules et accessoires », la racine) pour
   tout le catalogue. */
const CATEGORIE_PAR_TYPE = {
  moteur: '8137',
  boite: '2641',
  pont: '2641',
  transfert: '2641',
  mecatronique: '2641',
  embrayage: '2641',
  transmission: '2641',
  turbo: '2820',
  culasse: '2820',
  pieces_moteur: '2820',
  injection: '2727',
  eclairage: '3318',
  demarrage: '8231',
  capteur: '8234',
  freinage: '2977',
  suspension: '2935',
  carrosserie: '8227',
  retroviseur: '2642',
  vitrage: '2534',
  interieur: '8233',
  multimedia: '8526',
  securite: '2879',
  fluides: '2788',
  calculateur: '899',
};
const CATEGORIE_PAR_DEFAUT = '5613';

/* Type de pièce lu en TÊTE du nom (« Moteur … », « Pont arrière … ») : il
   corrige une fiche mal rangée (un moteur Porsche classé « Turbos »). Premier
   motif qui correspond, texte normalisé. */
const TYPES_PAR_NOM = [
  ['moteur', /^moteurs?\b(?!\s+(?:de|d'|d’)\s*(?:leve|essuie|ventil|chauffage|toit|reglage|siege|porte|retro|volet|serrure|antenne|capote|phare|pompe|demarr))/],
  ['transfert', /^(?:boites?\s+de\s+transfert|transfer\b|transfert\b|actionneur\s+(?:de\s+)?(?:la\s+)?boite\s+(?:de\s+)?transfert)/],
  ['boite', /^boites?\b/],
  ['pont', /^(?:ponts?|differentiels?|diff|renvoi\s+d['’]angle|reducteur)\b/],
  ['mecatronique', /^(?:mecatroniques?|tcu|tcm|calculateurs?\s+(?:de\s+)?boite|corps\s+de\s+valves?|module\s+ism|bloc\s+hydraulique|kit\s+(?:de\s+)?reparation\s+mecatronique)\b/],
  ['embrayage', /^(?:kits?\s+(?:d['’]\s*)?embrayage|embrayage|double\s+embrayage|volant\s+moteur|butee)/],
  ['transmission', /^(?:convertisseur|cardans?|arbres?\s+de\s+transmission|coupleur|actionneur\s+(?:de\s+)?coupleur)\b/],
  ['turbo', /^turbo(?:compresseur)?s?\b/],
  ['culasse', /^culasses?\b/],
  ['injection', /^(?:injecteurs?|pompes?\s+(?:a\s+|haute\s+pression|d['’]\s*)?injection|pompe\s+haute\s+pression|rampe\s+d['’]injection)\b/],
  ['eclairage', /^(?:phares?|feux|feu|paire\s+de\s+phares|optiques?|projecteurs?)\b/],
  ['demarrage', /^(?:demarreurs?|alternateurs?|kit\s+de\s+demarrage)\b/],
  ['freinage', /^(?:disques?|plaquettes?|etriers?)\b/],
  ['interieur', /^(?:accoudoirs?|consoles?)\b/],
  ['multimedia', /^(?:pcm|autoradio|systeme\s+multimedia|ecran\s+multimedia)\b/],
  ['calculateur', /^calculateurs?\b/],
];

/* Type de pièce lu dans la catégorie du site (chemin complet normalisé). */
const TYPES_PAR_CATEGORIE = [
  ['transfert', /transfert/],
  ['pont', /\bponts?\b|differentiel/],
  ['mecatronique', /^transmission\s*>\s*mecatronique/],
  ['calculateur', /calculateur/],
  ['embrayage', /embrayage/],
  ['transmission', /convertisseur|cardan/],
  ['boite', /boites?\s+de\s+vitesses?/],
  ['turbo', /turbo/],
  ['culasse', /culasse/],
  ['injection', /injecteur|injection/],
  ['demarrage', /alternateur|demarreur|demarrage|charge|batterie/],
  ['capteur', /capteur/],
  ['moteur', /^moteurs?$|bloc\s+moteur/],
  ['pieces_moteur', /refroidissement|allumage|vilebrequin|distribution|admission|filtre|bougie|^moteurs?\s*>/],
  ['freinage', /frein|plaquette|disque|etrier|\babs\b/],
  ['suspension', /suspension|amortisseur|ressort|triangle|rotule|cremaillere|direction/],
  ['eclairage', /phare|feux|eclairage/],
  ['retroviseur', /retroviseur/],
  ['vitrage', /essuie/],
  ['carrosserie', /pare[\s-]?chocs?|carrosserie/],
  ['multimedia', /multimedia/],
  ['securite', /airbag/],
  ['interieur', /console|accoudoir|habitacle/],
  ['fluides', /huile/],
  ['transmission', /^transmission\b/],
];

/** Type de pièce : d'après la tête du nom, sinon la catégorie — sa feuille
 *  d'abord (« Carrosserie / Éclairage > Pare-chocs » est un pare-chocs, pas un
 *  éclairage), puis le chemin complet —, sinon null. */
function typeDePiece(fiche) {
  const nom = normaliser(fiche && fiche.name).trim();
  for (const [type, rx] of TYPES_PAR_NOM) if (rx.test(nom)) return type;
  const categorie = normaliser(fiche && fiche.category).replace(/\s+/g, ' ').trim();
  const feuille = categorie.split('>').pop().trim();
  for (const cible of uniques([feuille, categorie])) {
    if (!cible) continue;
    for (const [type, rx] of TYPES_PAR_CATEGORIE) if (rx.test(cible)) return type;
  }
  return null;
}

/** Catégorie Google la plus précise sûre ; à défaut « Pièces détachées pour
 *  véhicules » (5613). */
function categorieGoogle(fiche) {
  return CATEGORIE_PAR_TYPE[typeDePiece(fiche)] || CATEGORIE_PAR_DEFAUT;
}

/* ─── Délais ──────────────────────────────────────────────────────────────── */

/* CGV art. 7.2 (version du 08/09/2026), en jours ouvrés :
     - pièces standards, mécatroniques, calculateurs : expédition sous 24–72 h
       ouvrées → préparation 1–3 j ; livraison sous 24–72 h de plus → transport 1–3 j ;
     - moteurs, boîtes de vitesses, ponts, boîtes de transfert, ensembles
       lourds : expédition sous 3–6 j ouvrés → préparation 3–6 j ; livraison
       sous 1–4 j ouvrés de plus → transport 1–4 j.
   Allemagne : 2 à 4 jours ouvrés après expédition (confirmé par Killian le
   17/09/2026, voir shippingPricing.cleDelaiLivraison).
   « Sauf indication différente sur la fiche produit » : un délai d'expédition
   PLUS LONG écrit sur la fiche (« 6-9 jours ») l'emporte ; un délai plus court
   (« 24-72h » sur une boîte) ne raccourcit pas la borne des CGV — les pièces
   sont sourcées à la commande, le stock du site n'est pas l'inventaire. */
const DELAIS_CGV = {
  standard: { preparation: [1, 3], transport: [1, 3] },
  lourd: { preparation: [3, 6], transport: [1, 4] },
};
const TRANSPORT_PAR_PAYS = { DE: [2, 4] };
const TYPES_LOURDS = new Set(['moteur', 'boite', 'pont', 'transfert']);
/* Classe d'expédition « lourde » (palette, moteur, boîte…) : même délai. */
const RX_CLASSE_LOURDE = /(palette|lourd|moteur|boite|pont|transfert|differentiel)/;

/** Pièce « lourde » au sens des CGV : moteur, boîte, pont, boîte de transfert,
 *  ou fiche expédiée sous une classe lourde. */
function estLourd(fiche, classe) {
  if (TYPES_LOURDS.has(typeDePiece(fiche))) return true;
  return !!(classe && RX_CLASSE_LOURDE.test(normaliser(`${classe.name || ''} ${classe.slug || ''}`)));
}

const RX_DUREE = /(\d{1,3})(?:\s*(?:-|–|—|a|au|\/|bis|et|ou)\s*(\d{1,3}))?\s*(h|heures?|std\.?|stunden|j|jours?|jrs?|tage|werktage|arbeitstage|semaines?|sem|wochen?)(?![a-z])/;

/** Délai d'expédition écrit sur la fiche, en jours ouvrés : { min, max } ou null.
 *  « 24 / 48h » → 1–2, « 3-5 jours » → 3–5, « sous 2 semaines » → 1–10. */
function delaiFicheEnJours(texte) {
  const m = normaliser(texte).match(RX_DUREE);
  if (!m) return null;
  const unite = m[3];
  const enJours = (v) => {
    if (/^(h|heure|std|stunde)/.test(unite)) return Math.max(1, Math.ceil(v / 24));
    if (/^(semaine|sem|woche)/.test(unite)) return v * 5;
    return v;
  };
  const a = enJours(Number(m[1]));
  const b = m[2] ? enJours(Number(m[2])) : null;
  let min = b === null ? Math.min(1, a) : Math.min(a, b);
  const max = b === null ? a : Math.max(a, b);
  if (!(max > 0) || max > 60) return null;
  min = Math.max(0, min);
  return { min, max };
}

/** Délai de préparation (commande → remise au transporteur), jours ouvrés. */
function delaisPreparation(fiche, { classe = null, textes = [] } = {}) {
  let [min, max] = (estLourd(fiche, classe) ? DELAIS_CGV.lourd : DELAIS_CGV.standard).preparation;
  for (const t of textes) {
    const d = delaiFicheEnJours(t);
    if (!d) continue;
    min = Math.max(min, d.min);
    max = Math.max(max, d.max);
  }
  return { min, max };
}

/** Délai de transport (remise au transporteur → livraison), jours ouvrés. */
function delaisTransport(fiche, { classe = null, pays = 'FR' } = {}) {
  const [min, max] = TRANSPORT_PAR_PAYS[pays] || (estLourd(fiche, classe) ? DELAIS_CGV.lourd : DELAIS_CGV.standard).transport;
  return { min, max };
}

/* ─── Sélection ───────────────────────────────────────────────────────────── */

/**
 * Motifs d'exclusion qui ne demandent aucun travail sur les textes, dans
 * l'ordre de MOTIFS. `images` : images brutes de la fiche (imagesDeLaFiche) ;
 * `usagesImages` : compterUsagesImages sur TOUTES les fiches publiées ;
 * `textesDelai` : délais affichés (français, et allemand pour la fiche /de).
 */
function motifsSansTexte(fiche, { images = [], usagesImages = new Map(), textesDelai = [], exclureConsigneEncaissee = true } = {}) {
  const motifs = [];
  if (fiche.serviceType === 'standalone_cloning') motifs.push(MOTIF.SERVICE_CLONAGE);
  if (claimFilter.familleDuSku(fiche.sku) === 'DM') motifs.push(MOTIF.COPIE_DISTRIMOTOR);
  if (!(Number(fiche.priceCents) > 0)) motifs.push(MOTIF.PRIX_INVALIDE);
  if (!slugValide(fiche)) motifs.push(MOTIF.SANS_SLUG);
  if (!images.length) motifs.push(MOTIF.SANS_IMAGE);
  if (fiche.inStock === false) motifs.push(MOTIF.HORS_STOCK);
  if (delaiNonGaranti(...textesDelai)) motifs.push(MOTIF.DELAI_NON_GARANTI);
  if (exclureConsigneEncaissee && consigneEncaissee(fiche)) motifs.push(MOTIF.CONSIGNE_ENCAISSEE);
  if (images.length && (usagesImages.get(cleImage(images[0])) || 0) > SEUIL_IMAGE_PARTAGEE) motifs.push(MOTIF.IMAGE_PARTAGEE);
  if (!etatDuProduit(fiche)) motifs.push(MOTIF.ETAT_INDETERMINE);
  return motifs;
}

/** Motifs qui lisent les textes affichés (déjà filtrés) : état contredit,
 *  titre générique. */
function motifsDesTextes(fiche, { titre }) {
  const motifs = [];
  const etat = etatDuProduit(fiche);
  if (etat && etatContradictoire(etat, fiche)) motifs.push(MOTIF.ETAT_CONTRADICTOIRE);
  if (titreGenerique(titre, fiche)) motifs.push(MOTIF.TITRE_GENERIQUE);
  return motifs;
}

function nouveauBilan() {
  return { fiches: 0, articles: 0, exclus: Object.fromEntries(MOTIFS.map(([code]) => [code, 0])) };
}

/** Écarte TOUS les candidats dont le titre est porté par un autre candidat
 *  (on ne choisit pas lequel garder : deux fiches au même titre ne se
 *  distinguent pas dans Shopping). */
function exclureTitresDupliques(candidats, bilan) {
  const nombre = new Map();
  for (const c of candidats) {
    const cle = cleTitre(c.titre);
    nombre.set(cle, (nombre.get(cle) || 0) + 1);
  }
  return candidats.filter((c) => {
    if (nombre.get(cleTitre(c.titre)) > 1) {
      if (bilan) bilan.exclus[MOTIF.TITRE_DUPLIQUE] += 1;
      return false;
    }
    return true;
  });
}

/** Une ligne de journal par construction : gardés, puis chaque motif non nul. */
function resumerBilan(nomFlux, bilan) {
  const nombre = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const exclus = MOTIFS
    .filter(([code]) => bilan.exclus[code] > 0)
    .map(([code]) => `${code} ${nombre(bilan.exclus[code])}`)
    .join(', ');
  return `[${nomFlux}] ${nombre(bilan.articles)} articles sur ${nombre(bilan.fiches)} fiches publiées`
    + (exclus ? ` — exclus : ${exclus}` : '');
}

/* ─── XML ─────────────────────────────────────────────────────────────────── */

/* Caractères interdits en XML 1.0 (contrôles, non-caractères, moitiés de paire
   UTF-16) : un seul, venu d'un texte importé, et Merchant rejette le fichier. */
const CARACTERES_INTERDITS_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function texteXml(valeur) {
  return String(valeur == null ? '' : valeur).replace(CARACTERES_INTERDITS_XML, '');
}

function xmlEscape(valeur) {
  return texteXml(valeur)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(valeur) {
  return `<![CDATA[${texteXml(valeur).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** Lignes XML d'un article (même gabarit pour les deux flux). */
function articleXml(it) {
  const l = [];
  const balise = (nom, valeur, retrait = '      ') => {
    if (valeur === null || valeur === undefined || valeur === '') return;
    l.push(`${retrait}<g:${nom}>${xmlEscape(valeur)}</g:${nom}>`);
  };
  l.push('    <item>');
  balise('id', it.id);
  balise('title', it.title);
  l.push(`      <g:description>${cdata(it.description)}</g:description>`);
  balise('link', it.link);
  balise('image_link', it.image_link);
  for (const ai of it.additional_image_link || []) balise('additional_image_link', ai);
  balise('availability', it.availability);
  balise('price', it.price);
  balise('condition', it.condition);
  balise('brand', it.brand);
  balise('mpn', it.mpn);
  balise('identifier_exists', it.identifier_exists);
  balise('google_product_category', it.google_product_category);
  balise('product_type', it.product_type);
  if (it.shipping) {
    const s = it.shipping;
    l.push('      <g:shipping>');
    balise('country', s.country, '        ');
    balise('service', s.service, '        ');
    balise('price', s.price, '        ');
    balise('min_handling_time', s.min_handling_time, '        ');
    balise('max_handling_time', s.max_handling_time, '        ');
    balise('min_transit_time', s.min_transit_time, '        ');
    balise('max_transit_time', s.max_transit_time, '        ');
    l.push('      </g:shipping>');
  }
  balise('min_handling_time', it.min_handling_time);
  balise('max_handling_time', it.max_handling_time);
  l.push('    </item>');
  return l;
}

function prixXml(cents) {
  return `${(Number(cents) / 100).toFixed(2)} EUR`;
}

/* Base déconnectée (démarrage, décrochage) : les routes répondent 503 +
   Retry-After. Un flux VIDE servi en 200 ferait retirer tous les articles par
   Merchant ; un échec de lecture, lui, les laisse en place jusqu'au prochain
   passage. */
const CODE_BASE_INDISPONIBLE = 'BASE_INDISPONIBLE';

function baseIndisponible() {
  const err = new Error('Base de données non connectée');
  err.code = CODE_BASE_INDISPONIBLE;
  return err;
}

module.exports = {
  BASE,
  CODE_BASE_INDISPONIBLE,
  baseIndisponible,
  CATEGORIE_PAR_DEFAUT,
  CATEGORIE_PAR_TYPE,
  DELAIS_CGV,
  DESCRIPTION_MAX,
  LIBELLE_MOTIF,
  MOTIF,
  MOTIFS,
  SEUIL_IMAGE_PARTAGEE,
  TITRE_MAX,
  articleXml,
  categorieGoogle,
  cdata,
  cleImage,
  cleTitre,
  compterUsagesImages,
  consigneEncaissee,
  delaiFicheEnJours,
  delaiNonGaranti,
  delaisPreparation,
  delaisTransport,
  descriptionDuFlux,
  descriptionFactuelle,
  estLourd,
  etatContradictoire,
  etatDuProduit,
  exclureTitresDupliques,
  imagesDeLaFiche,
  imagesPourFlux,
  marqueGoogle,
  motifsDesTextes,
  motifsSansTexte,
  mpnFiable,
  normaliserMarque,
  nouveauBilan,
  prixXml,
  resumerBilan,
  texteBrut,
  texteXml,
  titreDuFlux,
  titreGenerique,
  typeDePiece,
  urlAbsolueImage,
  xmlEscape,
};
