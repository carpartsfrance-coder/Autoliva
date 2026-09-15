'use strict';

/**
 * Qui signe un article de blog — à l'écran et dans le JSON-LD.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A12) ────────────────
 *
 * 1 101 articles sur 1 174 étaient signés « Expert CarParts », déclaré à
 * Google comme une PERSONNE (JSON-LD `author: Person`) alors qu'aucune
 * personne n'existe derrière : pas de biographie, /author/* répond 410, et
 * les articles ont été produits par une chaîne automatique, jusqu'à 325 en
 * deux jours. Pour un moteur qui juge la fiabilité d'un site, un faux auteur
 * est pire que pas d'auteur.
 *
 * Règle :
 *   - article RELU par une vraie personne (champs reviewedBy + reviewedAt,
 *     remplis dans l'admin par Killian lui-même) → cette personne signe, avec
 *     son rôle et la date, et l'article dit qu'il a été préparé avec l'aide
 *     d'outils d'IA ;
 *   - sinon → « L'équipe Autoliva », déclarée comme ORGANISATION.
 *
 * Une signature saisie à la main qui n'est pas une des personas de la chaîne
 * (« Expert CarParts », « Expert Autoliva », « Car Parts France »…) est
 * respectée : c'est un choix explicite fait dans l'admin.
 *
 * En allemand, seule la relecture de la version ALLEMANDE compte
 * (localizations.de.reviewedBy / reviewedAt) : relire le français ne vérifie
 * pas sa traduction.
 */

const PERSONAS = /^(expert\s*car\s*parts|expert\s*autoliva|car\s*parts\s*france|autoliva|autoliva-experte)$/i;

function texte(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function dateValide(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formaterDate(d, lang) {
  return d.toLocaleDateString(lang === 'de' ? 'de-DE' : 'fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
}

/**
 * @returns {{ nom: string, verification: string, mentionIa: string, auteurJsonLd: object }}
 */
function signature(post, { lang = 'fr', marque = 'Autoliva', baseUrl = '' } = {}) {
  const source = lang === 'de'
    ? ((post && post.localizations && post.localizations.de) || {})
    : (post || {});
  const relecteur = texte(source.reviewedBy);
  const relu = dateValide(source.reviewedAt);
  const role = lang === 'de' ? texte(source.reviewerRole) : texte(post && post.reviewerRole);

  if (relecteur && relu) {
    const qui = role ? `${relecteur}, ${role}` : relecteur;
    return lang === 'de'
      ? {
        nom: relecteur,
        verification: `Geprüft von ${qui}, am ${formaterDate(relu, 'de')}`,
        mentionIa: `Artikel mit Hilfe von KI-Werkzeugen erstellt, geprüft von ${relecteur}.`,
        auteurJsonLd: { '@type': 'Person', name: relecteur, ...(role ? { jobTitle: role } : {}) },
      }
      : {
        nom: relecteur,
        verification: `Vérifié par ${qui}, le ${formaterDate(relu, 'fr')}`,
        mentionIa: `Article préparé avec l'aide d'outils d'IA, vérifié par ${relecteur}.`,
        auteurJsonLd: { '@type': 'Person', name: relecteur, ...(role ? { jobTitle: role } : {}) },
      };
  }

  const saisi = texte(post && post.authorName);
  if (saisi && !PERSONAS.test(saisi)) {
    return { nom: saisi, verification: '', mentionIa: '', auteurJsonLd: { '@type': 'Person', name: saisi } };
  }

  /* `nom` suit « Par » / « Von » dans la ligne d'auteur (blog/show.ejs) :
     « Par l'équipe Autoliva », « Von der Autoliva-Redaktion » — et non
     « Par L'équipe » ni « Von Das Autoliva-Team », fautif en allemand. */
  return {
    nom: lang === 'de' ? `der ${marque}-Redaktion` : `l'équipe ${marque}`,
    verification: '',
    mentionIa: '',
    auteurJsonLd: { '@type': 'Organization', name: marque, ...(baseUrl ? { url: baseUrl } : {}) },
  };
}

module.exports = { signature, PERSONAS };
