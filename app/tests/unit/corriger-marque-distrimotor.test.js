/**
 * « Distrimotor » n'est pas une marque de voiture.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * 65 fiches ASY donnaient le nom d'un concurrent (distrimotor.com) comme
 * marque de véhicule, jusque dans leurs titres et leur version allemande.
 * Le script de correction est lancé par Killian ; ces tests verrouillent la
 * transformation, qui ne doit rien deviner et ne jamais toucher une adresse.
 */

const test = require('node:test');
const assert = require('node:assert');

const { transformer, corrigerCompatibilites } = require('../../scripts/corriger-marque-distrimotor');

test('entrée « Distrimotor » vide à côté des vraies marques : retirée', () => {
  const p = {
    sku: 'ASY-1', slug: 'moteur-bkc-audi-distrimotor', brand: 'Audi',
    name: 'Moteur Diesel BKC 1.9 105 ch reconditionné – Audi / Distrimotor',
    description: '<p>Ce moteur équipe notamment : Audi, Distrimotor. La puissance dépend de la version.</p>',
    seo: { metaDescription: 'Moteur BKC reconditionné pour Audi / Distrimotor. Livré nu.' },
    faqs: [{ question: 'Sur quels véhicules se monte-t-il ?', answer: 'Audi, Distrimotor' }],
    compatibility: [{ make: 'Audi', model: 'A3' }, { make: 'Distrimotor', model: '' }],
    localizations: { de: { slug: 'motor-bkc-audi-distrimotor', name: 'Dieselmotor BKC 1.9 105 PS – Audi / Distrimotor', description: 'Dieser Motor wird unter anderem in Audi, Distrimotor verbaut.' } },
  };
  const { set, manuel } = transformer(p);
  assert.deepEqual(manuel, []);
  assert.deepEqual(set.compatibility, [{ make: 'Audi', model: 'A3' }]);
  assert.equal(set.name, 'Moteur Diesel BKC 1.9 105 ch reconditionné – Audi');
  assert.equal(set.description, '<p>Ce moteur équipe notamment : Audi. La puissance dépend de la version.</p>');
  assert.equal(set['seo.metaDescription'], 'Moteur BKC reconditionné pour Audi. Livré nu.');
  assert.equal(set['faqs.0.answer'], 'Audi');
  assert.equal(set['localizations.de.name'], 'Dieselmotor BKC 1.9 105 PS – Audi');
  assert.equal(set['localizations.de.description'], 'Dieser Motor wird unter anderem in Audi verbaut.');
  assert.ok(!('slug' in set) && !('localizations.de.slug' in set), 'une adresse a été touchée');
  assert.ok(!('brand' in set), 'une vraie marque ne doit pas être remplacée');
});

test('modèle connu : la vraie marque, partout', () => {
  const p = {
    sku: 'ASY-2', brand: 'Distrimotor',
    name: 'Moteur Diesel 225A2000 1.3 80 ch reconditionné – Distrimotor',
    description: 'Ce moteur équipe notamment : Distrimotor Fiorino. Une solution fiable pour remettre votre Distrimotor en état.',
    resume: 'Moteur 1.3 reconditionné – Distrimotor. Compatible Distrimotor.',
    seo: { metaTitle: 'Moteur 225A2000 1.3 reconditionné Distrimotor | Autoliva' },
    compatibility: [{ make: 'Distrimotor', model: 'Fiorino', engine: '1.3L JTD', _id: 'x' }],
    localizations: { de: { description: 'Eine zuverlässige Lösung, um Ihren Distrimotor in Stand zu setzen.' } },
  };
  const { set, manuel } = transformer(p);
  assert.deepEqual(manuel, []);
  assert.deepEqual(set.compatibility, [{ make: 'Fiat', model: 'Fiorino', engine: '1.3L JTD' }]);
  assert.equal(set.brand, 'Fiat');
  assert.equal(set.name, 'Moteur Diesel 225A2000 1.3 80 ch reconditionné – Fiat');
  assert.equal(set.description, 'Ce moteur équipe notamment : Fiat Fiorino. Une solution fiable pour remettre votre Fiat en état.');
  assert.equal(set.resume, 'Moteur 1.3 reconditionné – Fiat. Compatible Fiat.');
  assert.equal(set['seo.metaTitle'], 'Moteur 225A2000 1.3 reconditionné Fiat | Autoliva');
  assert.equal(set['localizations.de.description'], 'Eine zuverlässige Lösung, um Ihren Fiat in Stand zu setzen.');
});

test('plusieurs véhicules sous une entrée : un par véhicule, sans doublon', () => {
  const c = corrigerCompatibilites([
    { make: 'Distrimotor', model: 'Boxer Daily Ducato Jumper', engine: '2.8' },
    { make: 'Iveco', model: 'Daily' },
  ]);
  assert.deepEqual(c.compat.map((e) => `${e.make} ${e.model}`), ['Peugeot Boxer', 'Fiat Ducato', 'Citroën Jumper', 'Iveco Daily'],
    'l’ordre d’origine est gardé, et Iveco Daily n’est pas dupliqué');
  assert.deepEqual(c.reprises, [{ avant: 'Distrimotor Boxer Daily Ducato Jumper', apres: 'Peugeot Boxer, Iveco Daily, Fiat Ducato, Citroën Jumper' }]);
  const { set } = transformer({
    sku: 'ASY-3', brand: 'Distrimotor', name: 'Moteur 2.8 reconditionné – Distrimotor / Peugeot / Citroën',
    description: 'Ce moteur équipe notamment : Distrimotor Boxer Daily Ducato Jumper, Peugeot Boxer.',
    compatibility: [{ make: 'Distrimotor', model: 'Boxer Daily Ducato Jumper' }],
  });
  assert.equal(set.name, 'Moteur 2.8 reconditionné – Peugeot / Citroën');
  assert.match(set.description, /Peugeot Boxer, Iveco Daily, Fiat Ducato, Citroën Jumper/);
  assert.equal(set.brand, 'Multimarque');
});

test('modèle inconnu : rien n’est deviné, la fiche part en relecture', () => {
  const { set, manuel } = transformer({
    sku: 'ASY-4', name: 'Moteur X – Distrimotor', compatibility: [{ make: 'Distrimotor', model: 'Zorglub 3000' }],
  });
  assert.ok(manuel.some((m) => /modèle inconnu/.test(m)));
  assert.ok(!('compatibility' in set) || set.compatibility.some((e) => e.make === 'Distrimotor'), 'une marque a été inventée');
});

test('seul l’endroit corrigé change : typographie et mise en forme du reste intactes', () => {
  /* Relevé sur les 63 descriptions à corriger : la normalisation portait sur
     tout le champ, « main d'œuvre ; » devenait « main d'œuvre; ». */
  const description = 'Ce moteur équipe notamment : Audi, Distrimotor. Garantie pièces et main d’œuvre ; livré nu !\n\nDeux  espaces ici ?';
  const { set, manuel } = transformer({
    sku: 'ASY-5', description,
    compatibility: [{ make: 'Audi', model: 'A3' }, { make: 'Distrimotor', model: '' }],
  });
  assert.deepEqual(manuel, []);
  assert.equal(set.description, 'Ce moteur équipe notamment : Audi. Garantie pièces et main d’œuvre ; livré nu !\n\nDeux  espaces ici ?');
  const marqueurInterne = String.fromCharCode(1);
  for (const v of Object.values(set)) assert.ok(typeof v !== 'string' || !v.includes(marqueurInterne), 'marqueur interne resté dans le texte');
});
