'use strict';

/**
 * Qui vient sur une famille d'URL : un résumé périodique des agents, dans les
 * journaux.
 *
 * ── Pourquoi (30/09/2026) ────────────────────────────────────────────────────
 *
 * Un robot a aspiré les pages véhicules : 123 397 requêtes sur /pieces-auto en
 * 24 h, la moitié du trafic du site, contre quelques centaines par jour
 * jusque-là. L'instance (1 CPU) est restée à 100 % toute la nuit et Render l'a
 * redémarrée douze fois — dont trois fois pour avoir dépassé les 2 Go.
 *
 * Impossible de dire QUI : notre mesure d'audience ne voit que 27 visites sur
 * ces pages dans la même journée (ce robot ne charge pas la page, il prend le
 * HTML et s'en va), et l'application ne journalise l'agent de personne. On ne
 * pouvait donc ni le nommer, ni prouver que ce n'était pas Google.
 *
 * Ce module compte, et écrit UNE ligne par intervalle — jamais une ligne par
 * requête : à 5 000 requêtes/heure, journaliser chacune ferait 120 000 lignes
 * par jour et coûterait plus cher que le robot lui-même.
 *
 * Ce qui est écrit : le nombre de requêtes, les trois agents les plus présents,
 * combien d'adresses IP distinctes chacun utilise, ce que l'agent PRÉTEND être
 * (robotDeclare) et si la vérification DNS inverse le confirme
 * (robotsVerifies) — se dire Googlebot ne suffit pas.
 */

const robotsVerifies = require('./robotsVerifies');

/* Au-delà, les nouveaux agents sont comptés ensemble : un robot qui tire un
   agent au hasard à chaque requête ne doit pas faire grossir la mémoire. */
const AGENTS_MAX = 200;
/* Assez pour distinguer « une machine » de « un botnet », sans garder la
   liste entière. */
const IPS_MAX = 50;
const UA_MAX = 160;
const INTERVALLE_MS = 5 * 60 * 1000;
const AUTRES = '(autres agents)';

/** Agent lisible et sûr à journaliser : ni retour à la ligne (une ligne de
 *  journal forgée), ni caractère de contrôle, ni longueur démesurée. */
function agentLisible(valeur) {
  const texte = String(valeur || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!texte) return '(agent vide)';
  return texte.length > UA_MAX ? `${texte.slice(0, UA_MAX)}…` : texte;
}

function nouveauSeau() {
  return { n: 0, ips: new Set(), ipsAuDela: 0, verifies: 0, declare: null };
}

/**
 * Middleware de comptage. `nom` apparaît dans la ligne de journal.
 * `journaliser`, `intervalleMs` et `maintenant` sont là pour les tests.
 */
function creerJournalAgents({
  nom,
  intervalleMs = INTERVALLE_MS,
  journaliser = (ligne) => console.log(ligne), // eslint-disable-line no-console
  maintenant = () => Date.now(),
} = {}) {
  let debut = maintenant();
  let total = 0;
  let agents = new Map();

  function seau(cle) {
    const existant = agents.get(cle);
    if (existant) return existant;
    /* Une place est gardée pour « (autres agents) » : la carte ne dépasse
       jamais AGENTS_MAX entrées. */
    if (agents.size >= AGENTS_MAX - 1) {
      const autres = agents.get(AUTRES) || nouveauSeau();
      agents.set(AUTRES, autres);
      return autres;
    }
    const neuf = nouveauSeau();
    agents.set(cle, neuf);
    return neuf;
  }

  function resume() {
    const classes = [...agents.entries()].sort((a, b) => b[1].n - a[1].n);
    const morceaux = classes.slice(0, 3).map(([ua, s]) => {
      const part = total ? Math.round((100 * s.n) / total) : 0;
      const ips = s.ips.size + s.ipsAuDela;
      const declare = s.declare ? `se dit ${s.declare}, ${s.verifies > 0 ? 'vérifié' : 'NON vérifié'}` : 'aucun robot déclaré';
      return `${s.n} (${part} %) « ${ua} » [${declare}, ${ips} IP${ips > 1 ? '' : ''}]`;
    });
    return `[agents ${nom}] ${Math.round(intervalleMs / 60000)} min : ${total} requêtes, `
      + `${agents.size} agent${agents.size > 1 ? 's' : ''} — ${morceaux.join(' ; ')}`;
  }

  function ecrireSiEcheance(instant) {
    if (instant - debut < intervalleMs) return;
    if (total > 0) journaliser(resume());
    debut = instant;
    total = 0;
    agents = new Map();
  }

  function middleware(req, res, next) {
    const instant = maintenant();
    try {
      /* L'échéance est regardée AVANT de compter : la requête qui arrive après
         l'intervalle appartient au suivant, sinon elle serait publiée dans le
         résumé de l'intervalle qu'elle vient de clore. */
      ecrireSiEcheance(instant);
      const ua = agentLisible(req && req.headers && req.headers['user-agent']);
      const s = seau(ua);
      s.n += 1;
      total += 1;
      const famille = robotsVerifies.robotDeclare(req && req.headers && req.headers['user-agent']);
      if (famille) s.declare = famille.nom;
      const ip = robotsVerifies.ipDuVisiteur(req);
      if (ip) {
        if (s.ips.size < IPS_MAX) s.ips.add(ip);
        else if (!s.ips.has(ip)) s.ipsAuDela += 1;
      }
      /* Vérification DNS inverse : en cache après le premier appel, et jamais
         attendue — le visiteur ne doit pas payer notre curiosité. Le seau est
         capturé : si l'intervalle bascule entre-temps, on écrit dans l'ancien,
         qui part à la poubelle. Sans conséquence. */
      if (famille) {
        Promise.resolve(robotsVerifies.estRobotVerifie(req))
          .then((ok) => { if (ok) s.verifies += 1; })
          .catch(() => {});
      }
    } catch (err) {
      /* Compter ne doit jamais empêcher de servir. */
    }
    return next();
  }

  middleware.__test = { resume: () => resume(), etat: () => ({ total, agents: agents.size }) };
  return middleware;
}

module.exports = { creerJournalAgents, agentLisible, AGENTS_MAX, IPS_MAX, INTERVALLE_MS };
