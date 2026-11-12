/**
 * Mise en page des messages SAV collés depuis ailleurs (demande du 01/10/2026).
 *
 * Lancé par : npm test (aucune base, aucun réseau).
 *
 * Ce qui est en jeu : une réponse rédigée dans ChatGPT puis collée dans le
 * ticket arrivait au client en un seul bloc — paragraphes, listes et gras
 * perdus, parce que le serveur ne gardait que le texte brut. On garde
 * maintenant la STRUCTURE, et seulement elle : l'habillage du logiciel
 * d'origine (polices, couleurs, classes) ne doit pas s'imposer à la place de
 * celui du site, et rien d'exécutable ne doit entrer.
 */

const test = require('node:test');
const assert = require('node:assert');

const { nettoyer, enTexte } = require('../../src/services/savMessageHtml');

/* Un copier-coller réel de ChatGPT : ses classes, ses styles en ligne, sa
   police maison, et la structure qui compte. */
const COLLE_CHATGPT = '<div class="markdown prose dark:prose-invert">'
  + '<p>Bonjour Jean,</p>'
  + '<p>Voici <strong>les étapes</strong> à suivre :</p>'
  + '<ol><li>Démonter la boîte</li><li>Relever le <em>code défaut</em></li></ol>'
  + '<p style="color:#374151;font-family:Söhne,sans-serif">Cordialement,<br>Le SAV</p>'
  + '</div>';

test('la structure du message est conservée', () => {
  const html = nettoyer(COLLE_CHATGPT);
  for (const bout of ['<p>Bonjour Jean,</p>', '<strong>les étapes</strong>', '<ol>', '<li>Démonter la boîte</li>', '<em>code défaut</em>', '<br />']) {
    assert.ok(html.includes(bout), `${bout} manque dans : ${html}`);
  }
});

test('l’habillage du logiciel d’origine est jeté', () => {
  const html = nettoyer(COLLE_CHATGPT);
  assert.ok(!/style=/.test(html), 'un style en ligne est passé');
  assert.ok(!/class=/.test(html), 'une classe est passée');
  assert.ok(!/Söhne|#374151/.test(html), 'la police ou la couleur d’origine est passée');
});

test('rien d’exécutable n’entre', () => {
  const html = nettoyer('<p>ok</p><script>alert(1)</script><p onclick="alert(2)">clic</p><iframe src="x"></iframe>');
  assert.ok(!/script|onclick|iframe/i.test(html), html);
  assert.ok(html.includes('<p>ok</p>'));
});

test('un lien javascript: perd son adresse, un vrai lien s’ouvre ailleurs', () => {
  const piege = nettoyer('<a href="javascript:alert(1)">clic</a>');
  assert.ok(!/javascript:/i.test(piege), piege);
  const vrai = nettoyer('<a href="https://autoliva.com/sav">suivi</a>');
  assert.match(vrai, /href="https:\/\/autoliva\.com\/sav"/);
  assert.match(vrai, /rel="noopener noreferrer"/);
});

test('un message sans texte ne laisse rien derrière lui', () => {
  /* Sinon une bulle vide s'afficherait à la place du texte brut. */
  for (const vide of ['', '   ', '<p> </p>', '<div><br></div>', '<p>&nbsp;</p>']) {
    assert.equal(nettoyer(vide), '', JSON.stringify(vide));
  }
});

test('un collage démesuré est refusé plutôt que stocké', () => {
  assert.equal(nettoyer('<p>' + 'a'.repeat(60000) + '</p>'), '');
});

test('le texte de secours garde les sauts de ligne et marque les listes', () => {
  const texte = enTexte(COLLE_CHATGPT);
  assert.equal(texte.split('\n')[0], 'Bonjour Jean,');
  assert.ok(texte.includes('• Démonter la boîte'), texte);
  assert.ok(texte.includes('Cordialement,\nLe SAV'), texte);
  assert.ok(!/<[a-z]/i.test(texte), 'du HTML est resté dans le texte');
});

/* ─── L'espace client affiche-t-il vraiment cette mise en page ? ───────────── */

process.env.BRAND = process.env.BRAND || 'autoliva';
const ejs = require('ejs');
const path = require('path');
const brand = require('../../src/config/brand');

const VUE = path.join(__dirname, '..', '..', 'src', 'views', 'sav', '_detail.ejs');

function rendre(messages) {
  const ticket = {
    numero: 'SAV-2026-0178',
    statut: 'ouvert',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    client: { prenom: 'Jean', nom: 'Dupont', email: 'jean@example.com' },
    messages,
    documentsList: [],
  };
  return ejs.render(
    require('fs').readFileSync(VUE, 'utf8'),
    { ticket, STATUTS_LABELS: { ouvert: ['Ouvert', 'bg-slate-100'] }, postUrl: '/sav/suivi', sent: false, error: null, brand },
    { filename: VUE }
  );
}

test('le client voit la mise en page du message, pas un bloc compact', () => {
  const html = rendre([{
    date: new Date('2026-10-01T09:00:00Z'), auteur: 'admin', canal: 'inapp',
    contenu: 'Bonjour Jean,\nVoici les étapes :\n• Démonter la boîte\n• Relever le code',
    html: '<p>Bonjour Jean,</p><ol><li>Démonter la boîte</li><li>Relever le code</li></ol>',
  }]);
  assert.match(html, /<ol><li>Démonter la boîte<\/li>/, 'la liste n’est pas rendue');
  assert.ok(html.includes('.sav-msg-riche ol'), 'sans ces règles, Tailwind écrase les marges et tout se recolle');
});

test('un message d’avant garde ses sauts de ligne', () => {
  /* Les messages enregistrés avant le 01/10/2026 n'ont pas de html : ils
     doivent continuer de s'afficher, sauts de ligne compris. */
  const html = rendre([{
    date: new Date('2026-09-20T09:00:00Z'), auteur: 'client', canal: 'inapp',
    contenu: 'Merci\n\nà bientôt',
  }]);
  assert.match(html, /whitespace-pre-wrap[^>]*>Merci/);
  assert.ok(!html.includes('sav-msg-riche"><'), 'une bulle riche vide a été rendue');
});
