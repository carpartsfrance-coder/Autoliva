'use strict';

/**
 * Traduction allemande automatique : en PAUSE VOLONTAIRE.
 *
 * Plan de reprise SEO du 14/09/2026, action A4.2 et décision 2 : la couche
 * allemande sort de Google et la traduction automatique reste coupée. Trois
 * choses à tenir :
 *   1. le balayage reste inscrit au planificateur — il alimente le flux
 *      Shopping allemand, qui ne prend que les fiches traduites ;
 *   2. il ne fait RIEN tant que DE_AUTO_TRANSLATE ne vaut pas exactement
 *      « true » (aucune base touchée, aucun appel payant) ;
 *   3. le tableau de bord cesse de réclamer qu'on le réarme.
 *
 * Aucune base de données, aucun appel réseau.
 */

const test = require('node:test');
const assert = require('node:assert');

const { verdictTraduction } = require('../../src/services/santeTraductionDe');

test('désarmée, la traduction est une pause voulue : ni alerte, ni appel à réarmer', () => {
  const avecAttente = verdictTraduction({ arme: false, enAttente: 37, quarantaine: 0 });
  assert.equal(avecAttente.verdict, 'pause', 'plus de rouge sur le tableau de bord');
  assert.match(avecAttente.message, /pause volontaire/);
  assert.match(avecAttente.message, /ne pas réarmer DE_AUTO_TRANSLATE/);
  assert.doesNotMatch(avecAttente.message, /n'est pas armée|non armée/, 'l’ancienne formulation poussait à réarmer');
  assert.match(avecAttente.message, /37 page/, 'le chiffre reste, pour information');
  assert.match(avecAttente.message, /flux Shopping allemand/, 'le coût de la pause est dit');

  const sansAttente = verdictTraduction({ arme: false, enAttente: 0 });
  assert.equal(sansAttente.verdict, 'pause');
  assert.match(sansAttente.message, /pause volontaire/);

  /* Même avec des pages mises de côté : tant que c'est désarmé, rien ne tourne,
     il n'y a donc rien d'alarmant à signaler. */
  assert.equal(verdictTraduction({ arme: false, enAttente: 5, quarantaine: 3 }).verdict, 'pause');
});

test('armée, les vraies pannes restent signalées comme avant', () => {
  assert.equal(verdictTraduction({ arme: true, enAttente: 4, quarantaine: 2 }).verdict, 'alerte');
  assert.equal(verdictTraduction({ arme: true, enAttente: 4, attenteDepuisH: 30 }).verdict, 'alerte');
  assert.equal(verdictTraduction({ arme: true, enAttente: 4, attenteDepuisH: 1 }).verdict, 'en_cours');
  assert.equal(verdictTraduction({ arme: true, enAttente: 0 }).verdict, 'ok');
});

test('le balayage allemand reste inscrit au planificateur, à la 42e minute', async (t) => {
  /* On remplace node-cron et le job par des doublures AVANT de charger le
     planificateur : on veut savoir ce qu'il inscrit, sans rien lancer. */
  const cronPath = require.resolve('node-cron');
  const jobPath = require.resolve('../../src/jobs/traduireNouveautesDe');
  const schedPath = require.resolve('../../src/jobs/scheduler');
  const sauvegarde = { cron: require.cache[cronPath], job: require.cache[jobPath], sched: require.cache[schedPath] };
  t.after(() => {
    for (const [p, v] of [[cronPath, sauvegarde.cron], [jobPath, sauvegarde.job], [schedPath, sauvegarde.sched]]) {
      if (v) require.cache[p] = v; else delete require.cache[p];
    }
  });

  const inscrits = [];
  require.cache[cronPath] = { id: cronPath, filename: cronPath, loaded: true, exports: { schedule: (expr, fn) => { inscrits.push({ expr, fn }); return { stop() {} }; } } };
  let appels = 0;
  const vraiJob = require('../../src/jobs/traduireNouveautesDe');
  require.cache[jobPath] = { id: jobPath, filename: jobPath, loaded: true, exports: { ...vraiJob, traduireNouveautesDe: async () => { appels++; return null; } } };
  delete require.cache[schedPath];

  require('../../src/jobs/scheduler').startScheduler();

  const de = inscrits.filter((i) => i.expr === '42 * * * *');
  assert.equal(de.length, 1, 'un créneau à la 42e minute');
  await de[0].fn();
  assert.equal(appels, 1, 'ce créneau lance bien le balayage allemand');
});

test('le balayage ne fait rien tant que DE_AUTO_TRANSLATE ne vaut pas exactement « true »', async (t) => {
  const { traduireNouveautesDe } = require('../../src/jobs/traduireNouveautesDe');
  const avant = process.env.DE_AUTO_TRANSLATE;
  const cle = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (avant === undefined) delete process.env.DE_AUTO_TRANSLATE; else process.env.DE_AUTO_TRANSLATE = avant;
    if (cle === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cle;
  });
  /* Une clé présente : si la garde ne tenait pas, le job irait jusqu'à la base.
     La base n'est pas connectée ici — il répondrait null pour une autre raison,
     d'où le contrôle de la connexion ci-dessous. */
  process.env.OPENAI_API_KEY = 'sk-test-jamais-utilisee';
  const mongoose = require('mongoose');
  for (const valeur of [undefined, '', 'false', '0', '1', 'yes', 'TRUE', 'True', ' true']) {
    if (valeur === undefined) delete process.env.DE_AUTO_TRANSLATE; else process.env.DE_AUTO_TRANSLATE = valeur;
    assert.strictEqual(await traduireNouveautesDe(), null, `DE_AUTO_TRANSLATE=${JSON.stringify(valeur)}`);
  }
  assert.equal(mongoose.connection.readyState, 0, 'aucune connexion tentée');

  /* Base absente, le test ci-dessus passerait même sans la garde. Sans clé
     OpenAI, en revanche, le job qui franchit la garde le DIT (« clé absente ») :
     désarmé, il doit se taire — c'est la preuve qu'il s'est arrêté avant. */
  process.env.OPENAI_API_KEY = '';
  const avertissements = [];
  const warn = console.warn;
  console.warn = (...args) => { avertissements.push(args.join(' ')); };
  try {
    for (const valeur of [undefined, 'false', '1', 'TRUE', ' true']) {
      if (valeur === undefined) delete process.env.DE_AUTO_TRANSLATE; else process.env.DE_AUTO_TRANSLATE = valeur;
      await traduireNouveautesDe();
    }
    assert.deepEqual(avertissements, [], 'désarmé, le balayage s’arrête avant même de chercher sa clé');
    process.env.DE_AUTO_TRANSLATE = 'true';
    await traduireNouveautesDe();
    assert.equal(avertissements.length, 1, 'armé, il va plus loin — le contrôle ci-dessus voit donc bien la garde');
  } finally {
    console.warn = warn;
  }
});
