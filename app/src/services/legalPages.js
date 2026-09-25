const LegalPage = require('../models/LegalPage');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderContentHtml(raw) {
  const input = typeof raw === 'string' ? raw : '';
  const escaped = escapeHtml(input);

  const urlRegex = /(https?:\/\/[^\s<]+[^<.,;:\s])/gi;
  const linkified = escaped.replace(urlRegex, (match) => {
    const url = match;
    return `<a href="${url}" target="_blank" rel="noreferrer" style="color:#dc2626;font-weight:700;text-decoration:none;">${url}</a>`;
  });

  return linkified.replace(/\r\n|\r|\n/g, '<br/>');
}

const DEFAULT_LEGAL_PAGES = [
  {
    slug: 'cgv',
    title: 'Conditions Générales de Vente (CGV)',
    sortOrder: 10,
    content: "À compléter dans l’admin.\n\nInformations recommandées :\n- Identité du vendeur (raison sociale, adresse, email, téléphone)\n- Produits / prix\n- Livraison\n- Paiement\n- Droit de rétractation\n- Retours / remboursement\n- Garanties\n- Responsabilité\n- Données personnelles\n- Loi applicable",
  },
  {
    slug: 'cgu',
    title: 'Conditions Générales d’Utilisation (CGU)',
    sortOrder: 20,
    content: "À compléter dans l’admin.\n\nInformations recommandées :\n- Objet du site\n- Accès au service\n- Compte utilisateur\n- Comportements interdits\n- Propriété intellectuelle\n- Limitation de responsabilité\n- Contact",
  },
  {
    slug: 'mentions-legales',
    title: 'Mentions légales',
    sortOrder: 30,
    content: "À compléter dans l’admin.\n\nInformations recommandées :\n- Éditeur du site\n- Hébergeur\n- Responsable de publication\n- Contact\n- N° SIRET / RCS\n- Adresse",
  },
  {
    slug: 'confidentialite',
    title: 'Politique de confidentialité',
    sortOrder: 40,
    content: "À compléter dans l’admin.\n\nInformations recommandées :\n- Données collectées\n- Finalités\n- Base légale\n- Durées de conservation\n- Droits (accès, suppression, etc.)\n- Contact\n- Cookies",
  },
  {
    slug: 'cookies',
    title: 'Politique cookies',
    sortOrder: 50,
    content: "À compléter dans l’admin.\n\nInformations recommandées :\n- Types de cookies\n- Durées\n- Comment gérer/retirer le consentement",
  },
];

/* ─── Pages encore provisoires : en ligne, mais hors de Google ─────────────
 *
 * Audit du 25/09/2026. Deux pages de confiance, liées depuis chaque pied de
 * page, étaient indexables alors qu'elles n'étaient pas écrites :
 *   - /legal/cookies montrait encore le texte d'attente des pages créées par
 *     défaut (« À compléter dans l’admin. Informations recommandées : … »),
 *     jusque dans sa description Google ;
 *   - /legal/cgv-sav (vue legal/cgv-sav.ejs) se dit « Version provisoire — en
 *     attente de validation juridique », tribunal « [VILLE À COMPLÉTER] ».
 * Elles restent en ligne (le formulaire SAV fait accepter les CGV SAV), mais
 * servies en « noindex, follow » et absentes de sitemap-pages.xml. Une page
 * légale qui reçoit son vrai texte dans l'admin revient d'elle-même. */

/* À passer à true le jour où un juriste a validé les CGV SAV — et retirer
   alors de la vue les mentions « provisoire » et « [VILLE À COMPLÉTER] ». */
const CGV_SAV_VALIDEES = false;
const SLUG_CGV_SAV = 'cgv-sav';

function normaliserTexteLegal(texte) {
  return String(texte == null ? '' : texte)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const TEXTES_PAR_DEFAUT = new Set(DEFAULT_LEGAL_PAGES.map((p) => normaliserTexteLegal(p.content)));

/**
 * Le contenu d'une page légale est-il encore un texte d'attente ? Vide, le
 * texte par défaut (même retouché : il commence par « À compléter » ou garde
 * « à compléter dans l'admin »), ou un marqueur « [… À COMPLÉTER …] ».
 */
function estContenuProvisoire(contenu) {
  const t = normaliserTexteLegal(contenu);
  if (!t) return true;
  if (TEXTES_PAR_DEFAUT.has(t)) return true;
  if (/^a completer\b/.test(t)) return true;
  if (/\ba completer dans l'admin\b/.test(t)) return true;
  if (/\[[^\]]*\ba completer\b[^\]]*\]/.test(t)) return true;
  return false;
}

/** Une page /legal/<slug> peut-elle figurer dans Google et le sitemap ? */
function pageLegaleIndexable({ slug, content } = {}) {
  if (getTrimmedString(slug).toLowerCase() === SLUG_CGV_SAV && !CGV_SAV_VALIDEES) return false;
  return !estContenuProvisoire(content);
}

/* « noindex, follow », sans jamais relâcher un « noindex, nofollow » déjà
   posé par app.js (hors production, FORCE_NOINDEX). */
function metaRobotsProvisoire(res) {
  const actuel = String((res && res.locals && res.locals.metaRobots) || '');
  return /noindex/i.test(actuel) ? actuel : 'noindex, follow';
}

async function ensureDefaultLegalPagesInDb() {
  try {
    const existing = await LegalPage.find({ slug: { $in: DEFAULT_LEGAL_PAGES.map((p) => p.slug) } })
      .select('slug')
      .lean();
    const existingSlugs = new Set((existing || []).map((p) => (p && p.slug ? String(p.slug) : '')));

    const missing = DEFAULT_LEGAL_PAGES.filter((p) => !existingSlugs.has(p.slug));
    if (!missing.length) return { ok: true, created: 0 };

    await LegalPage.insertMany(
      missing.map((p) => ({
        slug: p.slug,
        title: p.title,
        content: p.content,
        sortOrder: Number.isFinite(p.sortOrder) ? p.sortOrder : 0,
        isPublished: true,
      }))
    );

    return { ok: true, created: missing.length };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

function getDefaultLegalPage(slug) {
  const key = getTrimmedString(slug).toLowerCase();
  const found = DEFAULT_LEGAL_PAGES.find((p) => p.slug === key) || null;
  if (!found) return null;
  return {
    slug: found.slug,
    title: found.title,
    content: found.content,
    contentHtml: renderContentHtml(found.content),
    isPublished: true,
    sortOrder: found.sortOrder,
    updatedAt: null,
    provisoire: estContenuProvisoire(found.content),
  };
}

async function listLegalPages({ dbConnected, includeUnpublished = false } = {}) {
  if (!dbConnected) {
    return DEFAULT_LEGAL_PAGES
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((p) => getDefaultLegalPage(p.slug));
  }

  await ensureDefaultLegalPagesInDb();

  const query = includeUnpublished ? {} : { isPublished: { $ne: false } };

  const pages = await LegalPage.find(query)
    .sort({ sortOrder: 1, title: 1 })
    .lean();

  return (pages || []).map((p) => ({
    id: String(p._id),
    slug: p.slug,
    title: p.title,
    content: p.content || '',
    contentHtml: renderContentHtml(p.content || ''),
    isPublished: p.isPublished !== false,
    sortOrder: Number.isFinite(p.sortOrder) ? p.sortOrder : 0,
    updatedAt: p.updatedAt || null,
    provisoire: estContenuProvisoire(p.content),
  }));
}

/* `lang` sert à servir la version traduite. Le champ `deTraduite` est renvoyé
   à part : le contrôleur en a besoin pour décider entre servir l'allemand et
   rediriger vers le français — il ne peut pas le déduire du contenu, qui
   retombe sur le français quand la traduction manque. */
async function getLegalPageBySlug({ slug, dbConnected, includeUnpublished = false, lang } = {}) {
  const key = getTrimmedString(slug).toLowerCase();
  if (!key) return null;

  if (!dbConnected) {
    return getDefaultLegalPage(key);
  }

  await ensureDefaultLegalPagesInDb();

  const page = await LegalPage.findOne({ slug: key }).lean();
  if (!page) return null;
  if (!includeUnpublished && page.isPublished === false) return null;

  const de = (page.localizations && page.localizations.de) || {};
  const deTraduite = Boolean(de.translatedAt && String(de.content || '').trim());
  const servirDe = lang === 'de' && deTraduite;
  const contenu = servirDe ? de.content : (page.content || '');

  return {
    id: String(page._id),
    slug: page.slug,
    title: servirDe ? (de.title || page.title) : page.title,
    content: contenu,
    contentHtml: renderContentHtml(contenu),
    isPublished: page.isPublished !== false,
    sortOrder: Number.isFinite(page.sortOrder) ? page.sortOrder : 0,
    updatedAt: page.updatedAt || null,
    deTraduite,
    /* Jugé sur le texte FRANÇAIS, qui fait foi : sa traduction n'en est
       que le reflet. */
    provisoire: estContenuProvisoire(page.content),
  };
}

async function updateLegalPageBySlug({ slug, title, content, isPublished, sortOrder, dbConnected } = {}) {
  if (!dbConnected) return { ok: false, reason: 'db_unavailable' };

  const key = getTrimmedString(slug).toLowerCase();
  if (!key) return { ok: false, reason: 'missing_slug' };

  const nextTitle = getTrimmedString(title);
  if (!nextTitle) return { ok: false, reason: 'missing_title' };

  const nextContent = typeof content === 'string' ? content : '';
  const nextPublished = isPublished === true;
  const nextSortOrder = Number.isFinite(sortOrder) ? Math.floor(sortOrder) : 0;

  const updated = await LegalPage.findOneAndUpdate(
    { slug: key },
    {
      $set: {
        title: nextTitle,
        content: nextContent,
        isPublished: nextPublished,
        sortOrder: nextSortOrder,
      },
    },
    { new: true, upsert: true }
  ).lean();

  return { ok: true, page: updated };
}

module.exports = {
  DEFAULT_LEGAL_PAGES,
  CGV_SAV_VALIDEES,
  estContenuProvisoire,
  pageLegaleIndexable,
  metaRobotsProvisoire,
  ensureDefaultLegalPagesInDb,
  listLegalPages,
  getLegalPageBySlug,
  updateLegalPageBySlug,
};
