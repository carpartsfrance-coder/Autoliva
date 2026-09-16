/**
 * Dossier fournisseur SAV (anglais) : ce qui part chez le fournisseur.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Le fournisseur réclame les codes défaut (photo de la valise) et le résultat du
 * réglage de base. Le lien du PDF est public : il doit être signé, et ne jamais
 * ouvrir la facture du garage (nom et adresse du client).
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.SAV_API_TOKEN = process.env.SAV_API_TOKEN || 'test-token';
const dossier = require('../../src/services/savDossierFournisseur');

const OBD = '/sav-files/aaaaaaaaaaaaaaaaaaaaaaaa';
const FACTURE = '/sav-files/bbbbbbbbbbbbbbbbbbbbbbbb';
const PHOTO_MESSAGE = '/sav-files/cccccccccccccccccccccccc';

function ticket(overrides) {
  return Object.assign({
    numero: 'SAV-2026-0001',
    pieceType: 'mecatronique',
    numeroCommande: 'CP2026-000464',
    vehicule: { marque: 'VOLKSWAGEN', modele: 'GOLF', vin: 'WVWZZZAUZFW522663', kilometrage: 129590 },
    montage: { date: new Date('2026-09-03'), reglageBase: 'oui', momentPanne: 'moins_100km' },
    diagnostic: { symptomes: ['Mode dégradé'], codesDefaut: ['P1895', 'P073C'], description: 'Perte de pression' },
    client: { nom: 'Jean Client', email: 'jean@example.com', telephone: '+33600000000' },
    documentsList: [
      { kind: 'photoObd', url: OBD, mime: 'image/jpeg' },
      { kind: 'factureMontage', url: FACTURE, mime: 'application/pdf' },
      { kind: 'client_message', url: PHOTO_MESSAGE, mime: 'image/jpeg' },
    ],
    fournisseur: {},
  }, overrides || {});
}

test('rôles par défaut : photo OBD envoyée, facture et pièces jointes de message exclues', () => {
  const roles = Object.fromEntries(dossier.filesWithRoles(ticket()).map((f) => [f.url, f.role]));
  assert.equal(roles[OBD], 'obd');
  assert.equal(roles[FACTURE], 'exclu');
  assert.equal(roles[PHOTO_MESSAGE], 'exclu');
});

test('sans photo du réglage de base : dossier incomplet et demande au client prête', () => {
  const list = dossier.checklist(ticket());
  assert.equal(list.find((i) => i.key === 'photoObd').ok, true);
  assert.equal(list.find((i) => i.key === 'photoReglage').ok, false);
  const demande = dossier.clientRequestText(ticket());
  assert.match(demande, /réglage de base/);
  assert.doesNotMatch(demande, /codes défaut ;/);
});

test('une photo reçue par message peut devenir la photo du réglage de base', () => {
  const t = ticket({ fournisseur: { photosDossier: [{ url: PHOTO_MESSAGE, role: 'reglage' }] } });
  assert.equal(dossier.checklist(t).find((i) => i.key === 'photoReglage').ok, true);
  assert.equal(dossier.clientRequestText(t), '');
});

test('message anglais : commande, VIN, codes et lien, sans données personnelles', () => {
  const text = dossier.buildMessageEn(ticket(), { items: [{ name: 'Mécatronique DQ200', sku: 'MECA-1' }], createdAt: new Date('2026-07-13') }, 'https://example.com/dossier.pdf');
  assert.match(text, /Warranty claim \*SAV-2026-0001\*/);
  assert.match(text, /order CP2026-000464/);
  assert.match(text, /VIN WVWZZZAUZFW522663/);
  assert.match(text, /Fault codes: P1895, P073C/);
  assert.match(text, /basic settings done: Yes/);
  assert.match(text, /https:\/\/example\.com\/dossier\.pdf/);
  assert.doesNotMatch(text, /Jean|jean@example\.com|\+33600000000/);
});

test('lien public : signature exigée, facture jamais accessible', () => {
  const t = ticket();
  const h = dossier.signature(t.numero);
  assert.equal(dossier.verifySignature(t.numero, h), true);
  assert.equal(dossier.verifySignature(t.numero, 'faux'), false);
  assert.equal(dossier.verifySignature('SAV-2026-0002', h), false);
  assert.equal(dossier.fileSharedWithSupplier(t, 'aaaaaaaaaaaaaaaaaaaaaaaa', h), true);
  assert.equal(dossier.fileSharedWithSupplier(t, 'bbbbbbbbbbbbbbbbbbbbbbbb', h), false);
  assert.equal(dossier.fileSharedWithSupplier(t, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'faux'), false);
});
