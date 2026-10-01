/**
 * Les icônes du menu « Catalogue » sont-elles DANS la police embarquée ?
 *
 * ── Pourquoi (01/10/2026) ────────────────────────────────────────────────────
 *
 * La police d'icônes est réduite aux icônes utilisées (scripts/polices-locales).
 * Quand une icône manque, le navigateur n'affiche pas un vide : il écrit son
 * NOM, en 24 px, à la place du pictogramme. Sur l'accueil, le menu des
 * catégories affichait donc « cyclone » (Turbos), « linear_scale » (Ponts &
 * différentiels) et « view_in_ar » (Culasses) en toutes lettres, par-dessus la
 * liste — neuf icônes du menu étaient absentes du sous-ensemble.
 *
 * La cause : le script de génération ne lisait que les fichiers contenant
 * « material-symbols », et ces noms-là viennent d'une table de
 * services/categoryPublic.js, qui n'en parle pas. Ce test tient la promesse à
 * sa place : toute icône que le menu peut produire doit être embarquée.
 */

const test = require('node:test');
const assert = require('node:assert');

const manifest = require('../../public/fonts/manifest.json');
const categoryPublic = require('../../src/services/categoryPublic');

const EMBARQUEES = new Set(manifest.icones || []);

test('chaque icône du menu catégories est embarquée dans la police', () => {
  const manquantes = categoryPublic.icones().filter((nom) => !EMBARQUEES.has(nom));
  assert.deepEqual(manquantes, [],
    `icônes absentes de public/fonts/manifest.json — relancer node scripts/polices-locales.js : ${manquantes.join(', ')}`);
});

test('l’icône de repli est elle-même embarquée', () => {
  /* C'est elle que sert la fiche quand l'icône demandée est inconnue : si elle
     manquait, le repli écrirait « category » au milieu du menu. */
  assert.ok(EMBARQUEES.has(categoryPublic.ICONE_PAR_DEFAUT), categoryPublic.ICONE_PAR_DEFAUT);
});

test('le menu retombe sur l’icône générique pour une catégorie inconnue', () => {
  /* Le libellé ne correspond à aucune règle : on ne doit pas inventer un nom
     d'icône qui ne serait pas dans la police. */
  const { icones, ICONE_PAR_DEFAUT } = categoryPublic;
  assert.ok(icones().includes(ICONE_PAR_DEFAUT));
  assert.ok(icones().length >= 10, 'la table des icônes du menu a disparu ?');
});

test('la police embarque bien les icônes vues en production', () => {
  /* Les quatre que l'admin a posées sur de vraies catégories, plus celle des
     culasses (posée par la table). Elles écrivaient leur nom sur l'accueil. */
  for (const nom of ['cyclone', 'sync_alt', 'linear_scale', 'battery_charging_full', 'view_in_ar']) {
    assert.ok(EMBARQUEES.has(nom), `${nom} manque dans la police`);
  }
});
