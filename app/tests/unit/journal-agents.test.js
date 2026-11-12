/**
 * Journal des agents (services/journalAgents) — 30/09/2026.
 *
 * Il existe pour une raison précise : quand un robot a aspiré /pieces-auto
 * (123 397 requêtes en 24 h, la moitié du trafic), personne ne pouvait dire
 * qui c'était. Ce que ce test protège : une ligne par intervalle et pas une
 * par requête, l'agent le plus présent en tête, le nombre d'adresses IP, et la
 * différence entre « se dit Googlebot » et « vérifié ».
 */

const test = require('node:test');
const assert = require('node:assert');

const { creerJournalAgents, agentLisible, AGENTS_MAX } = require('../../src/services/journalAgents');

const UA_ASPIRATEUR = 'Mozilla/5.0 (compatible; AspirateurBot/2.0; +http://exemple.invalid/bot)';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function requete({ ua = UA_ASPIRATEUR, ip = '203.0.113.10' } = {}) {
  return { headers: { 'user-agent': ua, 'cf-connecting-ip': ip }, ip, socket: { remoteAddress: ip } };
}

/** Journal branché sur une horloge et un journal de test. */
function journalDeTest(options = {}) {
  const lignes = [];
  let instant = 1_000_000;
  const middleware = creerJournalAgents({
    nom: '/pieces-auto',
    intervalleMs: 5 * 60 * 1000,
    journaliser: (l) => lignes.push(l),
    maintenant: () => instant,
    ...options,
  });
  return {
    lignes,
    avancer: (ms) => { instant += ms; },
    appeler: (r) => new Promise((resolve) => middleware(requete(r), {}, resolve)),
    middleware,
  };
}

test('une seule ligne par intervalle, jamais une par requête', async () => {
  const j = journalDeTest();
  for (let i = 0; i < 500; i++) await j.appeler();
  assert.equal(j.lignes.length, 0, 'rien tant que l’intervalle n’est pas écoulé');

  j.avancer(5 * 60 * 1000);
  await j.appeler();
  assert.equal(j.lignes.length, 1, 'une ligne à l’échéance');
  assert.match(j.lignes[0], /^\[agents \/pieces-auto\] 5 min : 500 requêtes/);

  /* Le compteur repart de zéro : la 501e requête appartient à l’intervalle
     suivant, pas au précédent. */
  j.avancer(5 * 60 * 1000);
  await j.appeler();
  assert.equal(j.lignes.length, 2);
  assert.match(j.lignes[1], /: 1 requêtes/);
});

test('un intervalle sans trafic n’écrit rien', async () => {
  const j = journalDeTest();
  j.avancer(60 * 60 * 1000);
  assert.equal(j.lignes.length, 0);
  await j.appeler();
  assert.equal(j.lignes.length, 0, 'la première requête ne publie pas un intervalle vide');
});

test('l’agent le plus présent passe en tête, avec sa part et ses adresses', async () => {
  const j = journalDeTest();
  for (let i = 0; i < 90; i++) await j.appeler({ ip: `203.0.113.${(i % 3) + 1}` });
  for (let i = 0; i < 10; i++) await j.appeler({ ua: 'Mozilla/5.0 (Macintosh) Chrome/150', ip: '198.51.100.7' });
  j.avancer(5 * 60 * 1000);
  await j.appeler({ ua: 'Mozilla/5.0 (Macintosh) Chrome/150', ip: '198.51.100.7' });

  const ligne = j.lignes[0];
  assert.match(ligne, /100 requêtes, 2 agents/);
  const tete = ligne.indexOf('AspirateurBot');
  const suivant = ligne.indexOf('Macintosh');
  assert.ok(tete > -1 && suivant > tete, `l’aspirateur doit être en tête : ${ligne}`);
  assert.match(ligne, /90 \(90 %\)/);
  assert.match(ligne, /aucun robot déclaré, 3 IP/);
});

test('se dire Googlebot ne suffit pas : la ligne dit « NON vérifié »', async () => {
  const j = journalDeTest();
  for (let i = 0; i < 5; i++) await j.appeler({ ua: UA_GOOGLEBOT, ip: '203.0.113.99' });
  j.avancer(5 * 60 * 1000);
  await j.appeler({ ua: UA_GOOGLEBOT, ip: '203.0.113.99' });
  assert.match(j.lignes[0], /se dit Googlebot, NON vérifié/);
});

test('un agent qui change à chaque requête ne fait pas grossir la mémoire', async () => {
  const j = journalDeTest();
  for (let i = 0; i < AGENTS_MAX + 350; i++) await j.appeler({ ua: `Robot-${i}/1.0` });
  assert.ok(j.middleware.__test.etat().agents <= AGENTS_MAX,
    `agents retenus : ${j.middleware.__test.etat().agents}`);
  j.avancer(5 * 60 * 1000);
  await j.appeler();
  assert.match(j.lignes[0], /\(autres agents\)/);
});

test('un agent ne peut pas forger une ligne de journal', () => {
  assert.equal(agentLisible('curl/8\n[agents /pieces-auto] 0 requêtes'), 'curl/8 [agents /pieces-auto] 0 requêtes');
  assert.equal(agentLisible(''), '(agent vide)');
  assert.equal(agentLisible('x'.repeat(400)).length, 161, 'agent tronqué (160 + le caractère de coupure)');
});

test('compter ne doit jamais empêcher de servir', async () => {
  const j = journalDeTest();
  let servi = false;
  j.middleware(null, {}, () => { servi = true; });
  assert.ok(servi, 'next() est appelé même sans requête exploitable');
});
