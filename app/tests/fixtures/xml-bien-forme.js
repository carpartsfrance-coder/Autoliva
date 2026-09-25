'use strict';

/**
 * Contrôle de forme minimal d'un document XML (flux Merchant), sans
 * dépendance : sections CDATA fermées et correctement découpées, balises
 * équilibrées, ni « & » ni « < » nus dans le texte. Lève une AssertionError.
 */

const assert = require('node:assert');

function verifierXmlBienForme(xml) {
  const sansCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => {
    assert.ok(!m.slice(9, -3).includes(']]>'), 'CDATA mal découpé');
    return '';
  });
  assert.ok(!sansCdata.includes('<![CDATA['), 'CDATA non fermé');
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), 'caractère de contrôle interdit en XML');
  const pile = [];
  const rx = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|<\?xml[^>]*\?>/g;
  let fin = 0;
  let m;
  while ((m = rx.exec(sansCdata)) !== null) {
    const texte = sansCdata.slice(fin, m.index);
    assert.ok(!/<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(texte), `texte mal échappé : ${texte.slice(0, 80)}`);
    fin = m.index + m[0].length;
    if (!m[2] || m[4]) continue;
    if (m[1]) assert.equal(pile.pop(), m[2], `balise </${m[2]}> sans ouverture`);
    else pile.push(m[2]);
  }
  assert.ok(!/<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(sansCdata.slice(fin)), 'texte mal échappé en fin de document');
  assert.deepEqual(pile, [], 'balises non fermées');
}

module.exports = { verifierXmlBienForme };
