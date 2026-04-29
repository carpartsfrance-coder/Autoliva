function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeUrl(rawUrl) {
  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return '';
  if (input.startsWith('/')) return input;
  if (/^https?:\/\//i.test(input)) return input;
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

    if (trimmed === ':::product') {
      flushParagraph();
      flushList();
      flushQuote();
      flushOrderedList();
      blocks.push('<div class="blog-product-cta" data-product-cta="1"></div>');
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

module.exports = {
  escapeHtml,
  markdownToHtml,
  stripHtml,
};
