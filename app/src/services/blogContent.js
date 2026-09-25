function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Réécrit à la volée les anciens patterns d'URL WooCommerce/carpartsfrance
 * qui peuvent traîner dans le contenu DB (articles blog, seoText admin, etc.).
 * Évite que ces liens internes apparaissent en "broken internal links" dans
 * Semrush. La règle complète est dans wpRedirects.js mais on les normalise
 * AUSSI ici pour ne pas même les émettre dans le HTML rendu. */
function rewriteLegacyInternalUrl(input) {
  if (!input || typeof input !== 'string') return input;
  let u = input;
  // Domaines pleine URL → on retire pour traiter comme path relatif
  u = u.replace(/^https?:\/\/(?:www\.)?carpartsfrance\.fr/i, '');
  u = u.replace(/^https?:\/\/(?:www\.)?autoliva\.com/i, '');
  // /produit/X → /product/X/
  u = u.replace(/^\/produit\/([^/?#]+)\/?(\?[^#]*)?(#.*)?$/i, '/product/$1/$2$3');
  // /produits/SLUG → /product/SLUG/ (le router /produits sert le listing, donc
  // pas de capture avec slug sauf si le lien est explicite ; on n'agit qu'en
  // présence d'un slug derrière)
  u = u.replace(/^\/produits\/([^/?#]+)\/?(\?[^#]*)?(#.*)?$/i, '/product/$1/$2$3');
  // /shop/X et /boutique/X → /product/X/
  u = u.replace(/^\/(?:shop|boutique)\/([^/?#]+)\/?(\?[^#]*)?(#.*)?$/i, '/product/$1/$2$3');
  // /product-category/X et /categorie-produit/X → /categorie/X
  u = u.replace(/^\/(?:product-category|categorie-produit)\/([^/?#]+)\/?(\?[^#]*)?(#.*)?$/i, '/categorie/$1$2$3');
  // /categorie/X/ (trailing slash) → /categorie/X
  u = u.replace(/^\/categorie\/([^/?#]+)\/(\?[^#]*)?(#.*)?$/i, '/categorie/$1$2$3');
  // /marque/X → /pieces-auto/X
  u = u.replace(/^\/(?:marque|marque-voiture)\/([^/?#]+)\/?(\?[^#]*)?(#.*)?$/i, '/pieces-auto/$1$2$3');
  // /tag/X → /produits?q=X
  u = u.replace(/^\/(?:tag|tag-produit|product_tag)\/([^/?#]+)\/?$/i, (_, slug) => `/produits?q=${encodeURIComponent(slug)}`);
  // ?add-to-cart=… présent dans un lien → /panier
  if (/[?&]add-to-cart=/i.test(u)) u = '/panier';
  return u;
}

function normalizeUrl(rawUrl) {
  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return '';
  // Anchor pure
  if (input.startsWith('#')) return input;
  // mailto:, tel:, etc.
  if (/^(?:mailto:|tel:|javascript:)/i.test(input)) return input;
  // URL relative ou absolue HTTP : on normalise les patterns legacy
  if (input.startsWith('/') || /^https?:\/\//i.test(input)) {
    return rewriteLegacyInternalUrl(input);
  }
  return '';
}

function renderInlineMarkdown(text) {
  const src = typeof text === 'string' ? text : '';
  let out = escapeHtml(src);

  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const safeUrl = normalizeUrl(url);
    if (!safeUrl) return escapeHtml(label);
    return `<a href="${escapeHtml(safeUrl)}" class="text-primary underline">${escapeHtml(label)}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  return out;
}

function markdownToHtml(markdown) {
  const raw = typeof markdown === 'string' ? markdown : '';
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  const blocks = [];
  let paragraph = [];
  let inList = false;
  let listItems = [];
  let inCode = false;
  let codeLines = [];
  let inQuote = false;
  let quoteLines = [];
  let inTable = false;
  let tableLines = [];
  let inOrderedList = false;
  let orderedListItems = [];

  function flushCode() {
    if (!inCode) return;
    const code = escapeHtml(codeLines.join('\n'));
    blocks.push(`<pre><code>${code}</code></pre>`);
    inCode = false;
    codeLines = [];
  }

  function flushQuote() {
    if (!inQuote) return;
    const joined = quoteLines.join('\n').trim();
    if (joined) {
      const html = joined
        .split('\n')
        .map((l) => renderInlineMarkdown(l.trim()))
        .join('<br/>');
      const firstLine = quoteLines[0] || '';
      let cls = '';
      if (/Attention|Important|⚠️/i.test(firstLine)) {
        cls = ' class="blockquote-warning"';
      } else if (/Info|Bon à savoir|ℹ️|💡|Astuce|Conseil/i.test(firstLine)) {
        cls = ' class="blockquote-info"';
      }
      blocks.push(`<blockquote${cls}>${html}</blockquote>`);
    }
    inQuote = false;
    quoteLines = [];
  }

  function flushParagraph() {
    if (!paragraph.length) return;
    const joined = paragraph.join(' ').trim();
    if (joined) blocks.push(`<p>${renderInlineMarkdown(joined)}</p>`);
    paragraph = [];
  }

  function flushTable() {
    if (!inTable) return;
    const separator = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    let sepIndex = tableLines.findIndex(l => separator.test(l.trim()));
    const headerLines = sepIndex > 0 ? tableLines.slice(0, sepIndex) : [];
    const bodyLines = sepIndex > 0 ? tableLines.slice(sepIndex + 1) : tableLines;

    function parseCells(line) {
      let t = line.trim();
      if (t.startsWith('|')) t = t.slice(1);
      if (t.endsWith('|')) t = t.slice(0, -1);
      return t.split('|').map(c => renderInlineMarkdown(c.trim()));
    }

    let html = '<div class="table-wrapper"><table>';
    if (headerLines.length) {
      html += '<thead>';
      for (const hl of headerLines) {
        html += '<tr>' + parseCells(hl).map(c => `<th>${c}</th>`).join('') + '</tr>';
      }
      html += '</thead>';
    }
    if (bodyLines.length) {
      html += '<tbody>';
      for (const bl of bodyLines) {
        html += '<tr>' + parseCells(bl).map(c => `<td>${c}</td>`).join('') + '</tr>';
      }
      html += '</tbody>';
    }
    html += '</table></div>';
    blocks.push(html);
    inTable = false;
    tableLines = [];
  }

  function flushList() {
    if (!inList) return;
    const items = listItems
      .map((li) => `<li>${renderInlineMarkdown(li)}</li>`)
      .join('');
    blocks.push(`<ul>${items}</ul>`);
    inList = false;
    listItems = [];
  }

  function flushOrderedList() {
    if (!inOrderedList) return;
    if (orderedListItems.length === 1) {
      blocks.push(`<h3>${renderInlineMarkdown(orderedListItems[0])}</h3>`);
    } else {
      const items = orderedListItems
        .map((li) => `<li>${renderInlineMarkdown(li.replace(/^\d+[).]\s+/, ''))}</li>`)
        .join('');
      blocks.push(`<ol>${items}</ol>`);
    }
    inOrderedList = false;
    orderedListItems = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line.replace(/\t/g, '  '));
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      continue;
    }

    if (trimmed === '---' || trimmed === '***') {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      blocks.push('<hr/>');
      continue;
    }

    const imageMatch = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(trimmed);
    if (imageMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      const alt = String(imageMatch[1] || '').trim();
      const url = normalizeUrl(imageMatch[2]);
      if (url) {
        blocks.push(`<p><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy"/></p>`);
      }
      continue;
    }

    const yt = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{6,})/.exec(trimmed);
    if (yt && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
      const videoId = yt[4] ? String(yt[4]).split(/[?&]/)[0] : '';
      if (videoId) {
        flushParagraph();
        flushList();
        flushQuote();
        flushOrderedList();
        blocks.push(
          `<div style="position:relative;padding-top:56.25%;margin:1rem 0;border-radius:0.75rem;overflow:hidden;">`
          + `<iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(videoId)}" `
          + `title="YouTube video" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" `
          + `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`
          + `</div>`
        );
      }
      continue;
    }

    const boldTitleMatch = /^\*\*([^*]+)\*\*$/.exec(trimmed);
    if (boldTitleMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      const value = boldTitleMatch[1].trim();
      if (value) {
        const isNumbered = /^\d+[).]\s+/.test(value);
        const tag = 'h3';
        blocks.push(`<${tag}>${renderInlineMarkdown(value)}</${tag}>`);
      }
      continue;
    }

    const numberedTitleMatch = /^\d+[).]\s+(.+)$/.exec(trimmed);
    if (numberedTitleMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      inOrderedList = true;
      orderedListItems.push(trimmed);
      continue;
    }

    const h3 = trimmed.startsWith('### ') ? trimmed.slice(4).trim() : '';
    const h2 = !h3 && trimmed.startsWith('## ') ? trimmed.slice(3).trim() : '';
    const h1 = !h3 && !h2 && trimmed.startsWith('# ') ? trimmed.slice(2).trim() : '';

    if (h1 || h2 || h3) {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      const tag = h1 ? 'h2' : h2 ? 'h2' : 'h3';
      const value = h1 || h2 || h3;
      blocks.push(`<${tag}>${renderInlineMarkdown(value)}</${tag}>`);
      continue;
    }

    if (trimmed.startsWith('|')) {
      if (!inTable) {
        flushParagraph();
        flushList();
        flushQuote();
        flushOrderedList();
      }
      inTable = true;
      tableLines.push(trimmed);
      continue;
    }
    if (inTable) {
      flushTable();
    }

    const quoteMatch = /^>\s*(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      flushOrderedList();
      inQuote = true;
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    if (inQuote) {
      flushQuote();
    }

    const listMatch = /^(-|\*)\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      flushOrderedList();
      inList = true;
      listItems.push(listMatch[2].trim());
      continue;
    }

    if (inList) {
      flushList();
    }

    /* Encadré d'une fiche PRÉCISE : « :::product[slug] ». Seul « :::product »
       (la 1re fiche liée) était compris : la directive restait écrite en
       clair dans 6 articles gardés (audit du 25/09/2026). On pose un
       emplacement ; le contrôleur y met l'encadré de la fiche si elle existe
       et est publiée, sinon l'emplacement disparaît. */
    const produitNomme = DIRECTIVE_PRODUIT.exec(trimmed);
    if (produitNomme) {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      blocks.push(emplacementProduit(produitNomme[1]));
      continue;
    }

    if (trimmed === ':::product') {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      blocks.push(EMPLACEMENT_PRODUIT_LIE);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushOrderedList();
  flushTable();
  flushCode();

  return blocks.join('\n');
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/* ─── Encadrés produit dans le corps d'un article ─────────────────────────── */

/* « :::product » : encadré de la 1re fiche liée à l'article (relatedProductIds),
   posé par le contrôleur à cet emplacement. */
const EMPLACEMENT_PRODUIT_LIE = '<div class="blog-product-cta" data-product-cta="1"></div>';

/* « :::product[slug] » : encadré de la fiche qui porte ce slug. */
const DIRECTIVE_PRODUIT = /^:::product\[([a-z0-9][a-z0-9-]*)\]\s*(?::::)?$/i;
/* La même, restée en clair dans un corps HTML (article saisi en HTML,
   traduction allemande d'un article Markdown). */
const DIRECTIVE_PRODUIT_HTML = /<p>\s*:::product\[([a-z0-9][a-z0-9-]*)\]\s*(?::::)?\s*<\/p>/gi;
const DIRECTIVE_PRODUIT_LIE_HTML = /<p>\s*:::product\s*<\/p>/gi;
const EMPLACEMENT_PRODUIT_NOMME = /<div data-product-slug="([a-z0-9-]+)"><\/div>/g;

function emplacementProduit(slug) {
  return `<div data-product-slug="${escapeHtml(String(slug).toLowerCase())}"></div>`;
}

/** Directives restées en clair dans du HTML → mêmes emplacements que le Markdown. */
function directivesProduitHtml(html) {
  if (typeof html !== 'string' || !html) return html;
  return html
    .replace(DIRECTIVE_PRODUIT_HTML, (m, slug) => emplacementProduit(slug))
    .replace(DIRECTIVE_PRODUIT_LIE_HTML, EMPLACEMENT_PRODUIT_LIE);
}

/** Slugs des encadrés « :::product[slug] » d'un corps HTML, sans doublon. */
function slugsEncadresProduit(html) {
  if (typeof html !== 'string' || !html) return [];
  return [...new Set([...html.matchAll(EMPLACEMENT_PRODUIT_NOMME)].map((m) => m[1]))];
}

/**
 * Remplit chaque emplacement : `nomme(slug)` pour « :::product[slug] »,
 * `lie()` pour « :::product ». Un rendu vide (fiche absente, non publiée,
 * aucune fiche liée) retire l'emplacement : jamais de directive en clair ni
 * d'encadré vide (le cadre rouge s'affichait sans contenu).
 */
function remplirEncadresProduit(html, { nomme = () => '', lie = () => '' } = {}) {
  if (typeof html !== 'string' || !html) return html;
  return html
    .replace(EMPLACEMENT_PRODUIT_NOMME, (m, slug) => nomme(slug) || '')
    .split(EMPLACEMENT_PRODUIT_LIE).join(lie() || '');
}

module.exports = {
  escapeHtml,
  markdownToHtml,
  stripHtml,
  directivesProduitHtml,
  slugsEncadresProduit,
  remplirEncadresProduit,
};
