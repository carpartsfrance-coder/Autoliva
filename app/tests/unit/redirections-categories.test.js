/**
 * Anciennes adresses de catégories — audit SEO du 11/11/2026, problème 2.
 *
 * Lancé par : npm test  (aucune base, aucun réseau : modèle simulé)
 *
 * Le rendu réel (301 servis par l'application) est vérifié dans
 * tests/integration/audit-seo-novembre.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const { resoudre, nettoyerSlug, cibleTable } = require('../../src/services/redirectionsCategories');
const TABLE = require('../../src/data/seo/redirections-categories.json').redirections;

/* Modèle Category simulé : findOne({ slug, isActive }) ou findOne({ slugAliases }). */
function modele(categories) {
  return {
    findOne(filtre) {
      const trouvee = categories.find((c) => {
        if (c.isActive === false) return false;
        if (filtre.slug) return c.slug === filtre.slug;
        if (filtre.slugAliases) return (c.slugAliases || []).includes(filtre.slugAliases);
        return false;
      }) || null;
      return { select() { return { lean: async () => trouvee }; } };
    },
  };
}

const ACTIVES = modele([
  { slug: 'ponts-differentiels' },
  { slug: 'boites-de-transfert' },
  { slug: 'mecatroniques', slugAliases: ['mecatroniques-calculateurs'] },
  { slug: 'boites-de-vitesses' },
  { slug: 'moteurs' },
  { slug: 'turbos' },
  { slug: 'demarreurs-alternateurs' },
]);

test('les 15 anciennes adresses relevées dans la Search Console ont une cible', async () => {
  const relevees = [
    'moteur-diesel-echange-standard', 'moteur-alternateur-demarreur', 'moteur-vilebrequin',
    'transmission-boite-de-transfert', 'electricite-electronique-calculateurs', 'transmission-boite-de-vitesses',
    'moteur-bloc-moteur', 'transmission-mecatronique', 'moteur-turbo-admission', 'transmission',
    'transmission-pont-differentiel', 'ponts-neufs', 'pont-differentiel-avant', 'differentiels', 'mecatronique',
  ];
  for (const ancien of relevees) {
    const cible = await resoudre(ancien, { Category: ACTIVES });
    assert.notEqual(cible, null, `${ancien} : aucune cible`);
  }
});

test('chaque cible de la table est une catégorie de la taxonomie actuelle (ou le sommaire)', () => {
  const taxonomie = new Set(['', 'ponts-differentiels', 'boites-de-transfert', 'mecatroniques', 'boites-de-vitesses', 'moteurs', 'turbos', 'demarreurs-alternateurs']);
  for (const [ancien, cible] of Object.entries(TABLE)) {
    assert.ok(taxonomie.has(cible), `${ancien} → ${cible} : cible hors taxonomie`);
    assert.equal(ancien, nettoyerSlug(ancien), `${ancien} : clé non normalisée`);
  }
});

test('queue parasite retirée, slug valide retrouvé', async () => {
  assert.equal(nettoyerSlug('transmission-mecatronique31'), 'transmission-mecatronique');
  assert.equal(nettoyerSlug('Ponts-Differentiels'), 'ponts-differentiels');
  assert.equal(await resoudre('ponts-differentiels2', { Category: ACTIVES }), 'ponts-differentiels');
});

test('ancien slug gardé lors d’un renommage dans l’admin', async () => {
  assert.equal(await resoudre('mecatroniques-calculateurs', { Category: ACTIVES }), 'mecatroniques');
});

test('cible de la table renommée depuis dans l’admin : on suit sa nouvelle adresse', async () => {
  const renommee = modele([{ slug: 'mecatroniques-dsg', slugAliases: ['mecatroniques'] }]);
  assert.equal(await resoudre('transmission-mecatronique', { Category: renommee }), 'mecatroniques-dsg');
  assert.equal(await resoudre('mecatroniques', { Category: renommee }), 'mecatroniques-dsg');
});

test('cible absente ou désactivée : pas de redirection', async () => {
  const vide = modele([{ slug: 'moteurs', isActive: false }]);
  assert.equal(await resoudre('moteur-vilebrequin', { Category: vide }), null);
  assert.equal(await resoudre('inconnue-totalement', { Category: ACTIVES }), null);
  assert.equal(cibleTable('inconnue-totalement'), null);
  assert.equal(cibleTable('transmission'), '');
});
