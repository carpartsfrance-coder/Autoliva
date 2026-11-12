const mongoose = require('mongoose');
  
const { getPublicBaseUrlFromReq } = require('../services/categoryPublic');
const { listLegalPages, getLegalPageBySlug, metaRobotsProvisoire } = require('../services/legalPages');
const { buildHreflangSet, t, redirectionFrGardantLaLangue } = require('../services/i18n');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

const ENTITES_NOMMEES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—', euro: '€' };

/**
 * Entités HTML décodées. La description Google d'une page légale sortait du
 * contenu déjà ÉCHAPPÉ par renderContentHtml (« d'un » → « d&#39;un ») ; le
 * gabarit l'échappait une seconde fois et Google lisait « d&amp;#39;un ».
 * Deux passes au plus : l'échappement du rendu, puis une entité saisie telle
 * quelle dans l'admin (« &#39; » collé depuis un ancien site).
 */
function decoderEntites(texte) {
  let out = String(texte || '');
  for (let passe = 0; passe < 2 && /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(out); passe++) {
    out = out.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e.charAt(0) === '#') {
        const code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      const nom = e.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITES_NOMMEES, nom) ? ENTITES_NOMMEES[nom] : m;
    });
  }
  return out;
}

function normalizeMetaText(value) {
  return getTrimmedString(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function toSafeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

async function getLegalIndex(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const pages = await listLegalPages({ dbConnected });
    const title = `Informations légales, CGV, CGU et confidentialité | ${brand.NAME}`;
    const metaDescription = `Consulte les informations légales de ${brand.NAME} : CGV, CGU, mentions légales, confidentialité et cookies.`;
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/legal` : `${langPrefix}/legal`;
    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          name: 'Informations légales',
          url: canonicalUrl,
          description: metaDescription,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: t(req.lang, 'breadcrumb.homeLd'),
              item: baseUrl ? `${baseUrl}${langPrefix}/` : '/',
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: 'Informations légales',
              item: canonicalUrl,
            },
          ],
        },
      ],
    });

    return res.render('legal/index', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      jsonLd,
      dbConnected,
      pages,
    });
  } catch (err) {
    return next(err);
  }
}

async function getLegalPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const isDe = req.lang === 'de';
    const langPrefix = isDe ? '/de' : (req.lang === 'en' ? '/en' : '');
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const slug = req.params && req.params.slug ? String(req.params.slug) : '';

    const pageBrute = await getLegalPageBySlug({ slug, dbConnected, lang: req.lang });
    if (!pageBrute) {
      return res.status(404).render('errors/404', {
        title: t(req.lang, 'error.404.title'),
      });
    }

    /* Une page légale n'est servie en allemand que si elle EXISTE en allemand.
       Le pied de page annonçait « Impressum » et « AGB » et menait vers du
       français : promettre un document légal dans une langue et en servir une
       autre est pire que d'assumer le français. */
    if (isDe && !pageBrute.deTraduite) {
      /* …sans perdre la langue du visiteur. Le lien « AGB » obligatoire, juste
         au-dessus de « Zahlungspflichtig bestellen », mène ici : ouvrir les
         conditions — le geste que la loi demande — remettait la session en
         « fr », et la commande était créée en français (Order.lang, locale
         Mollie, confirmation et e-mails) pour un acheteur allemand. Le
         paramètre n'est posé que pour un humain : un robot suit l'URL nue. */
      return res.redirect(301, redirectionFrGardantLaLangue(req, '/legal/' + encodeURIComponent(pageBrute.slug)));
    }
    const page = pageBrute;

    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang, pageBrute.deTraduite
      ? { deHref: baseUrl ? `${baseUrl}/de/legal/${encodeURIComponent(pageBrute.slug)}` : `/de/legal/${pageBrute.slug}` }
      : undefined);

    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/legal/${encodeURIComponent(page.slug)}` : `${langPrefix}/legal/${encodeURIComponent(page.slug)}`;
    /* Décodée AVANT la coupe à 160 caractères : couper « d&#39; » en plein
       milieu laissait un reste d'entité en fin de description. */
    const contentText = decoderEntites(stripHtml(page && page.contentHtml ? page.contentHtml : ''));
    const metaDescription = truncateText(
      normalizeMetaText(contentText || `${page.title} sur ${brand.NAME}.`),
      160
    );
    const title = `${page.title} | ${brand.NAME}`;
    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          name: page.title,
          url: canonicalUrl,
          description: metaDescription,
          /* Pas de dateModified : updatedAt d'une page légale bouge aussi
             quand on écrit sa traduction allemande (translate-legal-de.js),
             sans que le texte change. Plan de reprise SEO, action A4.5. */
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: t(req.lang, 'breadcrumb.homeLd'),
              item: baseUrl ? `${baseUrl}${langPrefix}/` : '/',
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: t(req.lang, 'breadcrumb.legal'),
              item: baseUrl ? `${baseUrl}${langPrefix}/legal` : '/legal',
            },
            {
              '@type': 'ListItem',
              position: 3,
              name: page.title,
              item: canonicalUrl,
            },
          ],
        },
      ],
    });

    return res.render('legal/page', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      jsonLd,
      dbConnected,
      page,
      /* Texte d'attente (« À compléter dans l’admin… ») : la page reste en
         ligne mais sort de Google, et de sitemap-pages.xml (seoController). */
      ...(page.provisoire ? { metaRobots: metaRobotsProvisoire(res) } : {}),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getLegalIndex,
  getLegalPage,
  _pourTests: { decoderEntites },
};
