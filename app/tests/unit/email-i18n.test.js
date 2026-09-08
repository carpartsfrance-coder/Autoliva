'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { traduireHtml, traduireTexte, traduireEmail, langueDe, normaliser } = require('../../src/services/emailI18n');

/* La traduction des e-mails opère sur le HTML RENDU. Ce qui doit être garanti
   n'est pas la qualité de l'allemand — c'est qu'on ne casse jamais le message
   français, et qu'on ne touche jamais à autre chose qu'un nœud de texte. */

const TABLE = {
  'Bonjour': 'Hallo',
  'Quantité :': 'Menge:',
  'Mode de livraison :': 'Lieferart:',
  'Livraison (standard)': 'Versand (Standard)',
  'Confirmation de commande #': 'Bestellbestätigung #',
  'confirmée': 'bestätigt',
  ', votre commande est expédiée': ', Ihre Bestellung wurde versendet',
  'Commande': 'Bestellung',
};

test('ne touche jamais à l’intérieur d’une balise', () => {
  const html = '<a href="/panier?q=Bonjour" title="Bonjour" style="font:Bonjour">Bonjour</a>';
  const out = traduireHtml(html, TABLE);
  assert.strictEqual(out, '<a href="/panier?q=Bonjour" title="Bonjour" style="font:Bonjour">Hallo</a>');
});

test('ignore le contenu des balises style et script', () => {
  const html = '<style>.x{content:"Bonjour"}</style><script>var s="Bonjour";</script><p>Bonjour</p>';
  const out = traduireHtml(html, TABLE);
  assert.ok(out.includes('content:"Bonjour"'), 'le CSS reste intact');
  assert.ok(out.includes('var s="Bonjour"'), 'le JS reste intact');
  assert.ok(out.includes('<p>Hallo</p>'), 'le texte est traduit');
});

test('préserve le nombre de balises et de liens', () => {
  const html = '<table><tr><td>Quantité : <strong>3</strong></td><td><a href="/x">Bonjour</a></td></tr></table>';
  const out = traduireHtml(html, TABLE);
  assert.strictEqual((html.match(/<[a-z]/gi) || []).length, (out.match(/<[a-z]/gi) || []).length);
  assert.strictEqual((html.match(/href=/g) || []).length, (out.match(/href=/g) || []).length);
});

test('une chaîne absente de la table reste en français', () => {
  const html = '<p>Une phrase que personne n’a traduite.</p>';
  assert.strictEqual(traduireHtml(html, TABLE), html);
});

test('traduit autour d’une variable au milieu', () => {
  assert.strictEqual(
    traduireTexte('Commande #CP2026-000999 confirmée', TABLE),
    'Bestellung #CP2026-000999 bestätigt'
  );
});

test('traduit un préfixe suivi d’une variable', () => {
  assert.strictEqual(
    traduireTexte('Confirmation de commande #CP2026-000999', TABLE),
    'Bestellbestätigung #CP2026-000999'
  );
});

test('traduit un suffixe précédé d’une variable', () => {
  assert.strictEqual(
    traduireTexte('Hans, votre commande est expédiée', TABLE),
    'Hans, Ihre Bestellung wurde versendet'
  );
});

test('traduit récursivement deux expressions dans un même nœud', () => {
  /* « Mode de livraison : Livraison (standard) » est un seul nœud de texte
     mais deux expressions : sans récursion la moitié restait française. */
  assert.strictEqual(
    traduireHtml('<div>Mode de livraison : Livraison (standard)</div>', TABLE),
    '<div>Lieferart: Versand (Standard)</div>'
  );
});

test('le français est rendu tel quel, sans passer par la table', () => {
  const mail = { subject: 'Bonjour', html: '<p>Bonjour</p>', text: 'Bonjour' };
  assert.deepStrictEqual(traduireEmail(mail, 'fr'), mail);
  assert.deepStrictEqual(traduireEmail(mail, undefined), mail);
});

test('la langue vient de la commande, puis du lead, puis du compte', () => {
  assert.strictEqual(langueDe({ order: { lang: 'de' }, user: { lang: 'fr' } }), 'de');
  assert.strictEqual(langueDe({ lead: { lang: 'de' }, user: { lang: 'fr' } }), 'de');
  assert.strictEqual(langueDe({ user: { lang: 'de' } }), 'de');
  assert.strictEqual(langueDe({}), 'fr');
  assert.strictEqual(langueDe(), 'fr');
  assert.strictEqual(langueDe({ order: { lang: 'xx' } }), 'fr');
});

test('la normalisation absorbe les espaces insécables et l’indentation', () => {
  assert.strictEqual(normaliser('  Quantité&nbsp;:\n   '), 'Quantité :');
});

test('la table livrée couvre les libellés clés de la commande', () => {
  const dico = require('../../src/locales/emails-de.json');
  for (const cle of ['Bonjour', 'Adresse de livraison', 'Adresse de facturation', 'Articles']) {
    assert.ok(dico[cle], `« ${cle} » doit être traduit`);
    assert.notStrictEqual(dico[cle], cle, `« ${cle} » ne doit pas rester en français`);
  }
});
