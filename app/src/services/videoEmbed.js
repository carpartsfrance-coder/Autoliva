'use strict';

/**
 * Détecte les liens vidéo YouTube / Vimeo et renvoie de quoi les embarquer
 * (iframe) dans la galerie produit.
 *
 * Rationale : les vidéos lourdes (ex. moteur sur banc d'essai, 100-200 Mo) ne
 * doivent PAS être stockées en GridFS/MongoDB ni servies par l'app Node (pas de
 * streaming/Range, base qui gonfle, bande passante Render). On les héberge sur
 * YouTube/Vimeo (non listé) — qui ré-encodent + servent en streaming CDN — et on
 * ne garde que l'URL dans `product.media.videoUrl`.
 *
 * YouTube : embed via youtube-nocookie.com (déjà autorisé par la CSP frameSrc,
 * et plus respectueux RGPD — pas de cookies tant que l'utilisateur ne lance pas).
 *
 * @param {string} rawUrl
 * @returns {{provider:'youtube'|'vimeo', id:string, embedUrl:string, poster:string}|null}
 */
function parseVideoEmbed(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return null;

  // YouTube : watch?v=ID, youtu.be/ID, /embed/ID, /shorts/ID, /live/ID, /v/ID
  // ID = 11 caractères [A-Za-z0-9_-].
  const yt = url.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i
  );
  if (yt) {
    const id = yt[1];
    return {
      provider: 'youtube',
      id,
      embedUrl: 'https://www.youtube-nocookie.com/embed/' + id + '?rel=0&modestbranding=1',
      poster: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
    };
  }

  // Vimeo : vimeo.com/ID, vimeo.com/ID/HASH (non listé), player.vimeo.com/video/ID?h=HASH
  const vm = url.match(/(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)(?:\/([A-Za-z0-9]+))?/i);
  if (vm) {
    const id = vm[1];
    const hashPath = vm[2] || '';
    const hashQuery = (url.match(/[?&]h=([A-Za-z0-9]+)/i) || [])[1] || '';
    const h = hashQuery || hashPath;
    return {
      provider: 'vimeo',
      id,
      embedUrl: 'https://player.vimeo.com/video/' + id + (h ? '?h=' + h : ''),
      poster: '',
    };
  }

  return null;
}

module.exports = { parseVideoEmbed };
