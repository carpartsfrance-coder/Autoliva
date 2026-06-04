'use strict';

/**
 * Rendu HTML des blocs d'information — pensé pour des admins NON techniques :
 *  - Entrée (un seul saut de ligne) = vrai retour à la ligne (<br>), contrairement
 *    au markdown standard qui fusionne les lignes.
 *  - Ligne vide = nouveau paragraphe.
 *  - **gras**, *italique*, titres « ## », listes « - » / « * ».
 *  - Tout le reste est échappé (pas d'injection HTML).
 *
 * Le même algorithme est dupliqué côté client (aperçu en direct) dans
 * views/admin/info-blocks.ejs — garder les deux cohérents.
 */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text) {
  let s = escapeHtml(text);
  // Gras d'abord, puis italique (sur ce qui reste).
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function renderInfoBlockHtml(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push('<p>' + paragraph.join('<br>') + '</p>');
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list && list.length) {
      out.push('<ul>' + list.map((li) => '<li>' + li + '</li>').join('') + '</ul>');
    }
    list = null;
  };

  for (const lineRaw of lines) {
    const trimmed = lineRaw.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    const item = trimmed.match(/^[-*]\s+(.*)$/);

    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 4); // # -> h2, ## -> h3, ### -> h4
      out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      continue;
    }

    if (item) {
      flushParagraph();
      if (!list) list = [];
      list.push(renderInline(item[1]));
      continue;
    }

    // Ligne de texte normale → rejoint le paragraphe courant (saut de ligne = <br>).
    flushList();
    paragraph.push(renderInline(trimmed));
  }

  flushParagraph();
  flushList();

  return out.join('\n');
}

module.exports = { renderInfoBlockHtml, escapeHtml };
