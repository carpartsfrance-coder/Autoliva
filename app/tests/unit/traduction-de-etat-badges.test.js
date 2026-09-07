/**
 * Tests unitaires — traduction DE : état de la pièce, badges, catégorie.
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * ── L'incident évité (09/2026) ──────────────────────────────────────────────
 *
 * En figeant le glossaire pour que « reconditionné » donne toujours
 * « generalüberholt », la consigne est devenue trop absolue : le modèle s'est
 * mis à l'appliquer AUSSI aux pièces d'occasion. Résultat observé sur un essai
 * réel :
 *
 *   FR : Moteur Porsche Cayenne 955 Turbo 4.5 V8 M48.50 d'occasion contrôlé
 *   DE : generalüberholter Austauschmotor Porsche Cayenne 955 Turbo 4.5 V8
 *
 * Un moteur d'occasion annoncé comme entièrement refait à neuf. Ce n'est pas
 * une maladresse de style : c'est une allégation commerciale fausse, sur la
 * caractéristique qui justifie l'écart de prix.
 *
 * Ces tests verrouillent la chaîne complète — glossaire, consigne, collecte,
 * réintégration — pour que l'état ne puisse plus dériver.
 */

const test = require('node:test');
const assert = require('node:assert');

const t = require('../../src/services/productTranslator');

test('le glossaire distingue les trois états', async (sub) => {
  const table = new Map(t.GLOSSARY);
  const tout = t.GLOSSARY.map(([fr, de]) => fr + ' → ' + de).join('\n');

  await sub.test('reconditionné et occasion ne partagent aucun mot', () => {
    assert.match(table.get('reconditionné(e)') || '', /generalüberholt/);
    const occasion = t.GLOSSARY.filter(([fr]) => /occasion/i.test(fr)).map(([, de]) => de).join(' ');
    assert.ok(occasion.length, 'aucune entrée « occasion » dans le glossaire');
    assert.doesNotMatch(occasion, /generalüberholt|Austausch/i,
      'une pièce d’occasion ne doit jamais emprunter le vocabulaire du reconditionné');
  });

  await sub.test('« occasion » est traité comme un adjectif, pas comme un nom', () => {
    /* Sans cela, une BOÎTE d'occasion devenait un « Gebrauchtmotor » — un
       moteur d'occasion. C'est arrivé sur deux fiches Audi. */
    assert.ok(t.GLOSSARY.some(([fr, de]) => /adjectif/i.test(fr) && de === 'gebraucht'),
      'il manque l’entrée générique « d’occasion » → « gebraucht »');
    assert.ok(t.GLOSSARY.some(([, de]) => de === 'Gebrauchtgetriebe'),
      'il manque le cas de la boîte d’occasion');
  });

  await sub.test('« instandgesetzt » reste explicitement banni', () => {
    assert.match(tout, /instandgesetzt/, 'la mention d’interdiction a disparu du glossaire');
    assert.ok(!t.GLOSSARY.some(([fr, de]) => !/JAMAIS/i.test(fr) && /^instandgesetzt/i.test(de)),
      'aucun terme ne doit TRADUIRE vers instandgesetzt');
  });

  await sub.test('les gammes principales sont figées', () => {
    /* « Transfergetriebe » avait été inventé pour les boîtes de transfert,
       alors que le marché allemand dit « Verteilergetriebe ». */
    assert.equal(table.get('boîte de transfert'), 'Verteilergetriebe');
    assert.equal(table.get('boîte de vitesses'), 'Getriebe');
  });

  await sub.test('aucune entrée n’offre un CHOIX sur l’état', () => {
    /* La barre oblique = deux traductions possibles = le modèle tranche au
       hasard, fiche par fiche. C'est l'incohérence d'origine. */
    for (const cle of ['moteur reconditionné', 'boîte de vitesses reconditionnée', 'reconditionné(e)']) {
      assert.ok(!(table.get(cle) || '').includes(' / '), cle + ' propose encore un choix');
    }
  });
});

test('la consigne interdit de confondre les états', async (sub) => {
  const consigne = t.buildSystemPrompt();

  await sub.test('elle nomme les trois états séparément', () => {
    assert.match(consigne, /occasion/i);
    assert.match(consigne, /generalüberholt/);
    assert.match(consigne, /\bneu\b/);
  });

  await sub.test('elle interdit explicitement generalüberholt sur une occasion', () => {
    const bloc = consigne.slice(consigne.indexOf('occasion'));
    assert.match(bloc, /JAMAIS[^.]*generalüberholt|generalüberholt[^.]*JAMAIS/i,
      'l’interdiction doit être écrite noir sur blanc, pas suggérée');
  });

  await sub.test('elle réclame explicitement les badges', () => {
    /* Le modèle omettait cette clé courte, et la pastille restait française. */
    assert.match(consigne, /badges/);
  });
});

test('les badges font l’aller-retour sans se perdre', async (sub) => {
  const fr = { name: 'Boîte X', badges: { topLeft: 'Garantie 2 ans', condition: 'Reconditionné', cards: ['A', 'B'] } };

  await sub.test('ils partent bien à la traduction', () => {
    /* Le schéma les prévoyait et la surcouche les appliquait, mais ils
       n’étaient jamais ENVOYÉS : plomberie posée des deux côtés, débranchée
       au milieu. */
    const collecte = t.collectFields(fr);
    assert.ok(collecte.badges, 'badges absents de ce qui part au modèle');
    assert.equal(collecte.badges.condition, 'Reconditionné');
  });

  await sub.test('la traduction est reprise quand elle existe', () => {
    const out = t.reconcile(fr, { badges: { topLeft: '2 Jahre Garantie', condition: 'Generalüberholt', cards: ['A2', 'B2'] } });
    assert.equal(out.badges.condition, 'Generalüberholt');
    assert.deepEqual(out.badges.cards, ['A2', 'B2']);
  });

  await sub.test('le français reprend la main si le modèle omet la clé', () => {
    /* Une pastille française vaut mieux qu’une pastille absente. */
    const out = t.reconcile(fr, { name: 'Getriebe X' });
    assert.equal(out.badges.condition, 'Reconditionné');
  });

  await sub.test('des pastilles de longueur différente sont refusées EN BLOC', () => {
    /* Mieux vaut des pastilles françaises que des pastilles décalées, qui
       afficheraient la garantie à la place de l’état. */
    const out = t.reconcile(fr, { badges: { condition: 'Generalüberholt', cards: ['seulement une'] } });
    assert.deepEqual(out.badges.cards, ['A', 'B']);
    assert.equal(out.badges.condition, 'Generalüberholt', 'les autres sous-champs restent traduits');
  });
});
