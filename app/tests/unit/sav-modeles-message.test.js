/**
 * Modèles de message SAV livrés avec le site : copiés une fois en base, puis
 * modifiables et supprimables par l'équipe.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Avant le 16/09/2026, 17 modèles étaient figés dans le code (composeur,
 * bibliothèque serveur, playbooks) : impossible de les corriger ou de les retirer.
 */

const test = require('node:test');
const assert = require('node:assert');
const { defaultMessageTemplates, htmlToText } = require('../../src/config/savMessageTemplatesDefaults');

test('les 17 modèles existants sont repris, chacun avec un repère unique', () => {
  const list = defaultMessageTemplates();
  assert.equal(list.length, 17);
  const keys = new Set(list.map((t) => t.builtinKey));
  assert.equal(keys.size, list.length);
  list.forEach((t) => {
    assert.ok(t.title && t.title.length <= 80, t.builtinKey);
    assert.ok(t.body && t.body.length <= 5000, t.builtinKey);
    assert.ok(Array.isArray(t.motifs), t.builtinKey);
  });
});

test('les modèles de playbook gardent leur motif et passent en texte', () => {
  const pb = defaultMessageTemplates().filter((t) => t.builtinKey.startsWith('playbook:'));
  assert.ok(pb.length > 0);
  pb.forEach((t) => {
    assert.equal(t.motifs.length, 1, t.builtinKey);
    assert.doesNotMatch(t.body, /<[a-z/][^>]*>/i, t.builtinKey);
  });
  const general = defaultMessageTemplates().filter((t) => !t.builtinKey.startsWith('playbook:'));
  general.forEach((t) => assert.equal(t.motifs.length, 0, t.builtinKey));
});

test('conversion HTML → texte', () => {
  assert.equal(htmlToText('Bonjour {nom},<br><br>Dossier <strong>{numero}</strong>&nbsp;ok'), 'Bonjour {nom},\n\nDossier {numero} ok');
});
