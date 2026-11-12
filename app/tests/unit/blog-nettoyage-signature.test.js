/**
 * Articles de blog : restes de la chaîne de production retirés à l'affichage,
 * et plus de faux auteur.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Plan de reprise SEO du 14/09/2026, action A12. Mesuré sur les 1 174
 * articles publiés : 162 blocs JSON-LD collés dans le texte, 13 marqueurs
 * « <!-- backlink:cocon-… --> » affichés en clair, 96 articles montrant du
 * jargon « cocon / satellite / pilier », 364 « Car Parts France », 44 articles
 * liant une préproduction coupée (503). Et 1 101 articles signés « Expert
 * CarParts », déclaré à Google comme une personne qui n'existe pas.
 */

process.env.BRAND = 'autoliva';

const test = require('node:test');
const assert = require('node:assert');

const { nettoyerHtml, nettoyerMarkdown, estTitreJargon } = require('../../src/services/nettoyageArticle');
const { signature } = require('../../src/services/signatureArticle');

test('le JSON-LD collé dans le texte disparaît, brut ou échappé', () => {
  const md = 'Intro.\n\n<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage"}</script>\n\nSuite.';
  assert.doesNotMatch(nettoyerMarkdown(md), /ld\+json|@context/);
  const echappe = '<p>&lt;script type=&quot;application/ld+json&quot;&gt;{&quot;@context&quot;: 1}&lt;/script&gt;</p><p>Texte</p>';
  const out = nettoyerHtml(echappe);
  assert.doesNotMatch(out, /ld\+json|@context/);
  assert.match(out, /<p>Texte<\/p>/);
});

test('les marqueurs de la chaîne ne s’affichent plus', () => {
  const out = nettoyerHtml('<p>&lt;!-- backlink:cocon-clonage-v2-2026-05-13 --&gt;</p><p>Vrai texte</p>');
  assert.doesNotMatch(out, /backlink|cocon/);
  assert.match(out, /Vrai texte/);
});

test('les titres de plan SEO deviennent « À lire aussi »', () => {
  for (const titre of ['Articles liés du cocon BMW E60/E61', 'Ces guides complètent ce satellite', 'Cocons associés', 'Articles satellites', 'Maillage inter-cocons']) {
    assert.ok(estTitreJargon(titre), titre);
    assert.equal(nettoyerHtml(`<h2>${titre}</h2>`), '<h2>À lire aussi</h2>', titre);
  }
  assert.equal(nettoyerHtml('<h2>Themen-Cluster</h2>', { lang: 'de' }), '<h2>Weiterlesen</h2>');
});

test('les pièces de différentiel ne sont jamais prises pour du jargon', () => {
  for (const vrai of ['<h2>Satellites et planétaires : le cœur du différentiel</h2>', '<p>Roulements de porte-satellites et joints spi.</p>', '<h3>Usure des satellites et planétaires</h3>']) {
    assert.equal(nettoyerHtml(vrai), vrai);
  }
  assert.equal(nettoyerHtml('<p>Pilier B déformé après choc.</p>'), '<p>Pilier B déformé après choc.</p>');
});

test('les intitulés « pilier » sont nettoyés, les adresses des liens jamais', () => {
  const html = '<li><a href="/blog/moteur-bmw-s85-pilier-cocon">Moteur BMW S85B50A V10 — pilier complet</a></li>'
    + '<li><a href="/blog/x">Pilier Murano / JX35 / QX60</a></li>'
    + '<p>Ensuite dans le cocon DSG6 : le <a href="/blog/y">guide pilier mécatronique DSG6 DQ250</a>.</p>'
    + '<p>Voir notre cocon dédié <a href="/blog/z">ici</a> — l&#39;article pilier</p>';
  const out = nettoyerHtml(html);
  assert.match(out, /href="\/blog\/moteur-bmw-s85-pilier-cocon"/, 'une adresse de lien a été modifiée');
  assert.match(out, />Moteur BMW S85B50A V10<\/a>/);
  assert.match(out, />Guide Murano \/ JX35 \/ QX60</);
  assert.match(out, /Ensuite sur le même sujet : le <a href="\/blog\/y">guide complet mécatronique DSG6 DQ250<\/a>/);
  assert.match(out, /Voir notre dossier dédié/);
  assert.doesNotMatch(out.replace(/href="[^"]*"/g, ''), /cocon|pilier/i);
});

test('les liens vers la préproduction coupée pointent sur le site', () => {
  const out = nettoyerHtml('<a href="https://car-parts-france-fr-refonte.onrender.com/blog/boite-de-transfert-mercedes">x</a>');
  assert.equal(out, '<a href="/blog/boite-de-transfert-mercedes">x</a>');
  assert.equal(nettoyerHtml('<a href="https://car-parts-france-fr-refonte.onrender.com">x</a>'), '<a href="/">x</a>');
});

test('l’ancien nom devient Autoliva, y compris écrit d’un bloc', () => {
  const out = nettoyerHtml('<p>Pont reconditionné CarPartsFrance à 1 890 €, commandé chez Car Parts France.</p>');
  assert.doesNotMatch(out, /car ?parts ?france/i);
  assert.match(out, /Autoliva/);
});

test('signature : plus de personne fictive', async (sub) => {
  const opts = { lang: 'fr', marque: 'Autoliva', baseUrl: 'https://autoliva.com' };

  await sub.test('persona de la chaîne → l’équipe, déclarée comme organisation', () => {
    for (const persona of ['Expert CarParts', 'Car Parts France', 'Expert Autoliva', 'Autoliva', '']) {
      const s = signature({ authorName: persona }, opts);
      /* Affiché après « Par » : minuscule. */
      assert.equal(s.nom, 'l\'équipe Autoliva', persona);
      assert.equal(s.auteurJsonLd['@type'], 'Organization', persona);
      assert.equal(s.verification, '');
    }
  });

  await sub.test('relu par une vraie personne → elle signe, et l’IA est mentionnée', () => {
    const s = signature({ authorName: 'Expert CarParts', reviewedBy: 'Killian Belabbes', reviewerRole: 'gérant', reviewedAt: new Date('2026-09-20T12:00:00Z') }, opts);
    assert.equal(s.nom, 'Killian Belabbes');
    assert.equal(s.verification, 'Vérifié par Killian Belabbes, gérant, le 20 septembre 2026');
    assert.match(s.mentionIa, /outils d'IA, vérifié par Killian Belabbes/);
    assert.deepEqual(s.auteurJsonLd, { '@type': 'Person', name: 'Killian Belabbes', jobTitle: 'gérant' });
  });

  await sub.test('un nom sans date de relecture ne suffit pas', () => {
    const s = signature({ reviewedBy: 'Killian Belabbes' }, opts);
    assert.equal(s.auteurJsonLd['@type'], 'Organization');
  });

  await sub.test('en allemand, seule la relecture de la version allemande compte', () => {
    const relu = { reviewedBy: 'Killian Belabbes', reviewedAt: new Date('2026-09-20T12:00:00Z') };
    /* Affiché après « Von » : « Von der Autoliva-Redaktion », pas « Von Das … ». */
    assert.equal(signature(relu, { ...opts, lang: 'de' }).nom, 'der Autoliva-Redaktion');
    const s = signature({ localizations: { de: { reviewedBy: 'Jonas Weber', reviewedAt: new Date('2026-09-21T12:00:00Z') } } }, { ...opts, lang: 'de' });
    assert.match(s.verification, /^Geprüft von Jonas Weber, am 21\. September 2026$/);
  });

  await sub.test('une signature réelle saisie à la main est respectée', () => {
    const s = signature({ authorName: 'Marc Dupont' }, opts);
    assert.equal(s.nom, 'Marc Dupont');
    assert.equal(s.auteurJsonLd['@type'], 'Person');
  });
});

test('admin : la relecture exige un nom ET une date plausible', () => {
  const { lireRelecture } = require('../../src/controllers/blogAdminController')._pourTests;
  assert.equal(lireRelecture({ reviewedBy: 'Killian', reviewedAt: '2026-09-14' }).reviewedBy, 'Killian');
  assert.equal(lireRelecture({ reviewedBy: 'Killian', reviewedAt: '' }).reviewedAtDate, null);
  assert.equal(lireRelecture({ reviewedBy: '', reviewedAt: '2026-09-20' }).reviewedAtDate, null);
  assert.equal(lireRelecture({ reviewedBy: 'Killian', reviewedAt: '2099-01-01' }).reviewedAtDate, null, 'date future refusée');
  assert.equal(lireRelecture({ reviewedBy: 'Killian', reviewedAt: '20/09/2026' }).reviewedAtDate, null, 'format inattendu refusé');
  assert.equal(lireRelecture({ reviewedBy: 'Killian', reviewedAt: '2026-02-31' }).reviewedAtDate, null, 'jour inexistant refusé, pas reporté au 3 mars');
});

test('« pilier » : le jargon part, le vrai français reste', () => {
  /* Mesuré sur les articles publiés : « guide pilier complet » donnait
     « guide complet complet » (7 articles), « un pilier du marché » devenait
     « un guide du marché ». */
  assert.equal(nettoyerHtml('<p>Consultez notre guide pilier complet sur la boîte.</p>'), '<p>Consultez notre guide complet sur la boîte.</p>');
  assert.equal(nettoyerHtml('<p>X — le guide pilier complet.</p>'), '<p>X — le guide complet.</p>');
  assert.equal(nettoyerHtml('<p>La W211 est un pilier du marché de l&#39;occasion.</p>'), '<p>La W211 est un pilier du marché de l&#39;occasion.</p>');
  assert.equal(nettoyerHtml('<p>Les piliers de la fiabilité.</p>'), '<p>Les piliers de la fiabilité.</p>');
  assert.equal(nettoyerHtml('<p>Voir l&#39;article pilier sur la DSG.</p>'), '<p>Voir le guide complet sur la DSG.</p>');
  assert.equal(nettoyerHtml('<p>La fin de l&#39;article pilier.</p>'), '<p>La fin du guide complet.</p>');
  assert.equal(nettoyerHtml('<p>Retour à l’article pilier ici.</p>'), '<p>Retour au guide complet ici.</p>');
});

test('le jargon allemand de la traduction est retiré aussi', () => {
  const out = nettoyerHtml('<h2>Weitere Artikel aus dem Themen-Cluster</h2><p>Siehe unseren Säulenartikel und den Kokon zur DQ200. Die Satellitenräder bleiben.</p>', { lang: 'de' });
  assert.match(out, /<h2>Weiterlesen<\/h2>/);
  assert.match(out, /Siehe unseren Hauptartikel und den Themenbereich zur DQ200/);
  assert.match(out, /Satellitenräder bleiben/, 'une vraie pièce (Satellitenräder) ne doit pas être touchée');
});

test('admin : une relecture incomplète est signalée, pas ignorée', () => {
  const { lireRelecture } = require('../../src/controllers/blogAdminController')._pourTests;
  const sansDate = lireRelecture({ reviewedBy: 'Killian', reviewerRole: 'gérant', reviewedAt: '' });
  assert.match(sansDate.relectureErreur, /nom de la personne ET une date/);
  assert.equal(sansDate.reviewedBy, 'Killian', 'la saisie reste affichée');
  assert.equal(sansDate.reviewedAtDate, null, 'rien n’est enregistré');
  assert.equal(lireRelecture({}).relectureErreur, '', 'tout vide : pas de relecture, pas d’erreur');
  assert.equal(lireRelecture({ reviewedBy: 'Killian', reviewedAt: '2026-09-14' }).relectureErreur, '');
});
