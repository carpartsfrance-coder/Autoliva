/**
 * Pages de confiance : pages légales provisoires, descriptions sans reste
 * d'entité, chiffres SAV sans case vide.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Audit du 25/09/2026 : /legal/cookies (« À compléter dans l’admin… ») et
 * /legal/cgv-sav (« version provisoire », « [VILLE À COMPLÉTER] ») étaient
 * indexables ; des descriptions de pages légales portaient « d&amp;#39; » ;
 * /sav/notre-engagement affichait « — % » et « — dossiers en cours ». Le rendu
 * réel de ces pages est vérifié dans tests/integration/pages-confiance.test.js.
 */

process.env.BRAND = 'autoliva';

const test = require('node:test');
const assert = require('node:assert');

const legalPages = require('../../src/services/legalPages');
const { decoderEntites } = require('../../src/controllers/legalController')._pourTests;
const { chiffresAffichables } = require('../../src/services/savChiffresPublics');

test('page légale provisoire : le texte d’attente est reconnu, même retouché', () => {
  const { estContenuProvisoire, DEFAULT_LEGAL_PAGES } = legalPages;
  /* Les cinq textes créés par défaut, tels quels. */
  for (const p of DEFAULT_LEGAL_PAGES) assert.equal(estContenuProvisoire(p.content), true, p.slug);
  /* Ceux qu'on voit en production : apostrophe droite ou courbe, espaces et
     retours à la ligne différents, majuscules, texte ajouté après. */
  for (const texte of [
    "À compléter dans l'admin.",
    'A COMPLETER dans l’admin.\r\n\r\nInformations recommandées :\n- Types de cookies',
    '   À compléter.   ',
    'Politique cookies\n\nÀ compléter dans l’admin. Types de cookies, durées.',
    'Tribunal de commerce de [VILLE À COMPLÉTER].',
    '',
    '   ',
    null,
  ]) {
    assert.equal(estContenuProvisoire(texte), true, JSON.stringify(texte));
  }
  /* Un vrai texte n'est jamais pris pour une page provisoire, même s'il
     emploie le verbe « compléter ». */
  for (const texte of [
    'Article 1 — Objet. Les présentes conditions régissent…',
    'Le client doit compléter le formulaire de rétractation en annexe.',
    'Cookies de mesure d’audience : à compléter par votre consentement dans le bandeau.',
  ]) {
    assert.equal(estContenuProvisoire(texte), false, texte);
  }
});

test('page légale indexable : ni texte d’attente, ni CGV SAV non validées', () => {
  const { pageLegaleIndexable, CGV_SAV_VALIDEES } = legalPages;
  assert.equal(CGV_SAV_VALIDEES, false, 'les CGV SAV attendent toujours leur validation juridique');
  assert.equal(pageLegaleIndexable({ slug: 'cgv', content: 'Article 1 — Objet.' }), true);
  assert.equal(pageLegaleIndexable({ slug: 'cookies', content: "À compléter dans l’admin.\n\nInformations recommandées :\n- Types de cookies" }), false);
  assert.equal(pageLegaleIndexable({ slug: 'cgv-sav', content: 'Un texte complet.' }), false);
  assert.equal(pageLegaleIndexable({ slug: 'CGV-SAV ', content: 'Un texte complet.' }), false);
});

test('meta robots d’une page provisoire : noindex, follow — sans relâcher un nofollow déjà posé', () => {
  const { metaRobotsProvisoire } = legalPages;
  assert.equal(metaRobotsProvisoire({ locals: { metaRobots: 'index, follow' } }), 'noindex, follow');
  assert.equal(metaRobotsProvisoire({ locals: {} }), 'noindex, follow');
  assert.equal(metaRobotsProvisoire({ locals: { metaRobots: 'noindex, nofollow' } }), 'noindex, nofollow');
});

test('description d’une page légale : entités décodées, une seule fois échappée par le gabarit', () => {
  assert.equal(decoderEntites('Conditions d&#39;utilisation &amp; données'), "Conditions d'utilisation & données");
  /* Entité saisie telle quelle dans l'admin, puis échappée par le rendu. */
  assert.equal(decoderEntites('d&amp;#39;un contrat'), "d'un contrat");
  assert.equal(decoderEntites('l&#x27;éditeur&nbsp;: Car Parts&rsquo;'), 'l\'éditeur : Car Parts’');
  assert.equal(decoderEntites('Texte sans entité'), 'Texte sans entité');
  assert.equal(decoderEntites('&inconnue; reste'), '&inconnue; reste');
});

test('chiffres SAV publics : seulement ce qui est mesuré', () => {
  assert.equal(chiffresAffichables({ enCours: 0, analyses: 0, defauts: 0 }), null, 'rien de mesuré : pas de section');
  assert.deepEqual(chiffresAffichables({ enCours: 4, analyses: 0, defauts: 0 }), { tauxDefautProduit: null, dossiersEnCours: 4 },
    'aucune analyse conclue ne fait pas « 0 % »');
  assert.deepEqual(chiffresAffichables({ enCours: 0, analyses: 8, defauts: 3 }), { tauxDefautProduit: 38, dossiersEnCours: null });
  assert.deepEqual(chiffresAffichables({ enCours: 2, analyses: 4, defauts: 0 }), { tauxDefautProduit: 0, dossiersEnCours: 2 },
    'un vrai 0 % (analyses conclues, aucun défaut) reste affiché');
});
