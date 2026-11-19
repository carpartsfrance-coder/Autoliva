/**
 * Résumé « quelle pièce, pour quel véhicule » de la liste des leads
 * (services/leadResume.js). Cas tirés des vrais formulaires du site.
 */
const test = require('node:test');
const assert = require('node:assert');
const { resumeDemande } = require('../../src/services/leadResume');

test('landing pont : la pièce est dans « véhicule » et dans le message, la plaque à part', () => {
  const r = resumeDemande({ captureSource: 'landing_ponts', requested: {
    plate: 'BE251FQ', vehicle: 'Boîte de transfert reconditionné(e) — échange standard', message: 'Pièce demandée : Boîte de transfert' } });
  assert.equal(r.piece, 'Boîte de transfert');
  assert.equal(r.vehicule, '', 'la pièce n’est pas répétée comme véhicule');
  assert.equal(r.plaque, 'BE251FQ');
});

test('landing : le numéro de dossier (AUT-…) n’est pas une pièce', () => {
  const r = resumeDemande({ captureSource: 'landing_ponts', requested: { ref: 'AUT-2026-11-TEST01', vehicle: 'Boîte de transfert reconditionné(e)' } });
  assert.equal(r.piece, 'Boîte de transfert');
});

test('landing moteur : « Occasion » n’est pas un véhicule ; le moteur identifié en atelier l’est', () => {
  const r = resumeDemande({ captureSource: 'landing_moteurs', requested: { plate: 'AM122TG', vehicle: 'Occasion', message: 'Moteur E350 CDI' },
    engineQuote: { identifiedEngine: { code: 'OM642', model: 'Mercedes Classe E 350 CDI' } } });
  assert.equal(r.piece, 'Moteur E350 CDI');
  assert.equal(r.vehicule, 'Mercedes Classe E 350 CDI (OM642)');
});

test('demande de devis depuis une fiche produit : la référence, le véhicule et le VIN', () => {
  const r = resumeDemande({ captureSource: 'devis', requested: { ref: '02E 325 025', vehicle: 'Seat Cupra ST', vin: 'VSSZZZ5FZGR076791' } });
  assert.deepEqual(r, { piece: '02E 325 025', pieceDuSms: false, vehicule: 'Seat Cupra ST', plaque: '', vin: 'VSSZZZ5FZGR076791' });
});

test('appel manqué : la réponse SMS du client dit ce qu’il cherche', () => {
  const r = resumeDemande({ captureSource: 'appel_manque', notes: [
    { text: 'RÉPONSE SMS du client : « Je cherche un moteur Dacia Duster 1.2 TCe »' },
    { text: 'Dossier pris en charge par Killian' },
  ] });
  assert.equal(r.piece, 'Je cherche un moteur Dacia Duster 1.2 TCe');
  /* Ce n'est que le début du SMS : la liste l'affiche faute de mieux, la
     fiche le montre comme un message et écrit « Non précisée » sous Pièce. */
  assert.equal(r.pieceDuSms, true);
});

test('panier : le premier article ; rien du tout : la pièce du formulaire', () => {
  assert.equal(resumeDemande({ captureSource: 'cart_activity', items: [{ name: 'Mécatronique DQ250' }] }).piece, 'Mécatronique DQ250');
  assert.equal(resumeDemande({ captureSource: 'landing_boites', requested: {} }).piece, 'Boîte de vitesses');
  assert.equal(resumeDemande({ captureSource: 'newsletter' }).piece, '');
});
