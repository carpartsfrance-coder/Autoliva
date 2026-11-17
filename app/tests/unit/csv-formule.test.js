/**
 * Exports CSV (comptabilité, SAV) : une cellule saisie par un client qui
 * commence par = + - @ ne doit pas devenir une formule dans Excel.
 * Les vrais nombres (-12,50) et les téléphones (+33…) restent intacts.
 */
const test = require('node:test');
const assert = require('node:assert');
const { csvCell } = require('../../src/services/accountingService');

test('csv : formules neutralisées, nombres intacts', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","clic")'), '"\'=HYPERLINK(""http://x"",""clic"")"');
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-abc'), "'-abc");
  assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell(-3), '-3');
  assert.equal(csvCell('+33 6 12 34 56 78'), '+33 6 12 34 56 78');
  assert.equal(csvCell('Jean Dupont'), 'Jean Dupont');
  assert.equal(csvCell(null), '');
});
