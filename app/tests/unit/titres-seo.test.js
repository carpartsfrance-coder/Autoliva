/**
 * Titres de page sans « … » — audit SEO du 11/11/2026, problème 5.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Avant : chaque contrôleur coupait au caractère près, posait « … » et
 * recollait « | Autoliva » — la référence de la pièce tombait le plus souvent
 * (« Pont arrière reconditionné Ford Kuga II 2.0 TDCi… | Autoliva »). Les cas
 * ci-dessous sont des titres réels relevés sur le site le 11/11/2026.
 */

const test = require('node:test');
const assert = require('node:assert');

const { ajusterTitre, separerSuffixe, couper, estCode, TITRE_MAX } = require('../../src/services/titreSeo');

const S = ' | Autoliva';

function verifierForme(titre, quoi) {
  assert.ok(titre.length <= TITRE_MAX, `${quoi} : ${titre.length} caractères (« ${titre} »)`);
  assert.ok(!titre.includes('…'), `${quoi} : « … » dans « ${titre} »`);
  assert.doesNotMatch(titre, /[\s—–\-|/:;,(]$/, `${quoi} : ponctuation pendante dans « ${titre} »`);
  assert.doesNotMatch(titre, /\s(de|du|des|et|pour|avec|en|à|au|aux|sur|le|la|les)$/i, `${quoi} : mot vide final dans « ${titre} »`);
}

test('un titre qui tient avec la marque reste entier', () => {
  assert.equal(ajusterTitre('Ponts & différentiels - Pièces auto', { suffixe: S, modeSuffixe: 'prefere' }), 'Ponts & différentiels - Pièces auto | Autoliva');
  assert.equal(ajusterTitre('Mécatronique DSG7 DQ200 0AM reconditionnée', { suffixe: S }), 'Mécatronique DSG7 DQ200 0AM reconditionnée | Autoliva');
});

test('fiches : la référence n’est jamais coupée, la marque saute plutôt que le texte', () => {
  const cas = [
    ['Pont arrière reconditionné Ford Kuga II 2.0 TDCi AWD CV6W-4000-DB - échange standard', 'CV6W-4000-DB'],
    ['Pont arrière reconditionné BMW X1 E84 xDrive18d / xDrive20d rapport 2,79 - 33107592939', '33107592939'],
    ['Pont arrière reconditionné BMW X1 E84 xDrive 18d / 20d ratio 2,79 - 33107592938 / 33107592937', '33107592938'],
    ['Boîte de transfert reconditionnée échange standard Porsche Macan 95B - 95B341010', '95B341010'],
    ['Mécatronique DSG7 DQ200 (0AM/0CW) reconditionnée (VAG) avec huile et levier - 0AM325065', '0AM325065'],
    ['Boîte de vitesses reconditionnée Volkswagen Transporter 2.5 TDI — HNE', 'HNE'],
    ['Différentiel avant reconditionné Mercedes CLA, GLA, Classe A 4MATIC — 2462800200', '2462800200'],
  ];
  for (const [nom, ref] of cas) {
    const titre = ajusterTitre(nom, { suffixe: S, modeSuffixe: 'facultatif' });
    verifierForme(titre, nom);
    assert.ok(titre.includes(ref), `« ${ref} » absent de « ${titre} »`);
  }
});

test('deux fiches voisines ne finissent plus avec le même titre', () => {
  const a = ajusterTitre('Pont arrière reconditionné BMW X1 E84 xDrive18d / xDrive20d rapport 2,79 - 33107592939', { suffixe: S });
  const b = ajusterTitre('Pont arrière reconditionné BMW X1 E84 xDrive 18d / 20d ratio 2,79 - 33107592938 / 33107592937', { suffixe: S });
  assert.notEqual(a, b);
});

test('un titre saisi en base qui tient sans la marque reste entier', () => {
  const saisi = 'Différentiel avant Mercedes — 2462800200 CLA reconditionné';
  assert.equal(ajusterTitre(saisi, { suffixe: S }), saisi);
});

test('« échange standard » ne saute que s’il faut gagner de la place', () => {
  assert.equal(ajusterTitre('Pont arrière échange standard Toyota Hilux', { suffixe: S }), 'Pont arrière échange standard Toyota Hilux | Autoliva');
  const long = ajusterTitre('Boîte de transfert reconditionnée échange standard Porsche Macan 95B - 95B341010', { suffixe: S });
  assert.ok(long.includes('Porsche Macan'), long);
});

test('articles : codes défaut et codes boîte gardés, marque gardée si le texte reste parlant', () => {
  const a = ajusterTitre('Accumulateur de pression DSG7 DQ200 : fissure P17BF, symptômes et réparation', { suffixe: S, modeSuffixe: 'prefere' });
  verifierForme(a, 'article P17BF');
  assert.ok(a.includes('P17BF') && a.includes('DQ200') && a.endsWith(S), a);
  const b = ajusterTitre('Mécatronique DSG7 DQ381/DQ380 : diagnostic, prix et remplacement', { suffixe: S, modeSuffixe: 'prefere' });
  assert.equal(b, 'Mécatronique DSG7 DQ381/DQ380 : diagnostic, prix | Autoliva');
});

test('identifiants nommés par l’appelant (référence fabricant) protégés', () => {
  const t = ajusterTitre('Turbo reconditionné Garett pour Opel Astra Zafira Meriva 1.7 CDTI 125 ch 80536744 garanti', { suffixe: S, proteger: ['80536744'] });
  verifierForme(t, 'turbo');
  assert.ok(t.includes('80536744'), t);
});

test('séparer la marque d’un titre déjà suffixé', () => {
  assert.deepEqual(separerSuffixe('Mon article | Autoliva', 'Autoliva'), { texte: 'Mon article', suffixe: ' | Autoliva' });
  assert.deepEqual(separerSuffixe('Mon article - Autoliva', 'Autoliva'), { texte: 'Mon article', suffixe: ' | Autoliva' });
  assert.deepEqual(separerSuffixe('Mon article', 'Autoliva'), { texte: 'Mon article', suffixe: '' });
});

test('cas limites : vide, mot unique trop long, parenthèse orpheline', () => {
  assert.equal(ajusterTitre('', { suffixe: S }), 'Autoliva');
  const mot = 'x'.repeat(90);
  assert.equal(ajusterTitre(mot).length, TITRE_MAX);
  const t = couper('Pièces auto Land Rover Range Rover Evoque (L538 AWD 2011-2018) occasion', 45);
  assert.equal((t.match(/\(/g) || []).length, (t.match(/\)/g) || []).length, t);
});

test('ce qui est un code et ce qui n’en est pas', () => {
  for (const c of ['DQ200', 'P17BF', '2462800200', 'CV6W-4000-DB', '0AM/0CW', 'xDrive18d']) assert.ok(estCode(c), c);
  for (const c of ['2.0', 'E84', 'II', 'TDCi', '4x4', '1,9']) assert.ok(!estCode(c), c);
});
