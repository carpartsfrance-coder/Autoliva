/**
 * Tests unitaires — filtre anti-robots du formulaire « Conseil expert » des
 * articles de blog, et migration qui range les robots déjà en base.
 *
 * Lancé par : npm test  (aucune base de données, aucun envoi réel)
 *
 * ── Le problème (11/2026) ───────────────────────────────────────────────────
 * 209 des 230 leads « Article blog » des 90 derniers jours venaient d'un robot :
 * prénom seul, numéro américain (+1…), aucun véhicule, message en anglais sans
 * rapport. Ils faisaient un tiers de la file « À traiter » du commercial, et le
 * site leur envoyait un email de confirmation.
 *
 * Même compromis que le formulaire de contact : DEUX signaux concordants. Les
 * cas « vrais clients » ci-dessous sont relevés dans la base de production.
 */

const test = require('node:test');
const assert = require('node:assert');

const filtre = require('../../src/services/leadSpamFilter');
const { signauxRobotIntact } = require('../../src/migrations/archiveBlogSpamLeads');

/* Gabarit exact du robot observé le 18/11/2026. */
const ROBOT = { phone: '+12732963132', vehicle: '', vin: '', plate: '' };

test('le robot du formulaire blog est écarté', async (t) => {
  await t.test('son gabarit réunit les deux signaux', () => {
    assert.deepEqual(filtre.signauxBlog(ROBOT), ['telephone_hors_zone', 'aucun_vehicule']);
    assert.equal(filtre.estSpamBlog(ROBOT), true);
  });

  await t.test('ses numéros relevés en production sont tous hors zone', () => {
    for (const tel of ['+19353224406', '+12534012987', '+19944756267', '+18009831498', '+1 (418) 803-8691']) {
      assert.equal(filtre.telephoneHorsZone(tel), true, tel);
    }
  });
});

test('un seul signal ne suffit jamais : les vrais demandeurs passent', async (t) => {
  await t.test('un client français avec son véhicule', () => {
    const c = { phone: '0617351541', vehicle: 'AUDI Q5 2.0 TDI Quattro S-Tronic7', vin: 'WAUZZZ8R4DA029793' };
    assert.deepEqual(filtre.signauxBlog(c), []);
  });

  await t.test('le formulaire de la colonne de droite (email seul)', () => {
    /* Il ne demande ni téléphone ni véhicule : « aucun véhicule » seul. */
    assert.deepEqual(filtre.signauxBlog({}), ['aucun_vehicule']);
    assert.equal(filtre.estSpamBlog({}), false);
  });

  await t.test('un client canadien qui décrit sa voiture', () => {
    const c = { phone: '+15145550123', vehicle: 'Audi A4 B8 2.0 TDI' };
    assert.deepEqual(filtre.signauxBlog(c), ['telephone_hors_zone']);
    assert.equal(filtre.estSpamBlog(c), false);
  });

  await t.test('les pays desservis ne sont jamais « hors zone »', () => {
    for (const tel of ['+33612345678', '+32470123456', '+41791234567', '+49151234567', '+352621123456',
                       '+212661600543', '+590690745773', '+262692123456', '+447700900123', '+905321234567']) {
      assert.equal(filtre.telephoneHorsZone(tel), false, tel);
    }
  });

  await t.test('un numéro sans « + » relève de l’autre filtre, pas de celui-ci', () => {
    for (const tel of ['0612345678', '3462874521', '', null]) {
      assert.equal(filtre.telephoneHorsZone(tel), false, String(tel));
    }
  });
});

test('la migration ne range que les robots jamais traités', async (t) => {
  const robot = { captureSource: 'blog_cta', phone: '+12732963132', requested: { vehicle: '', vin: '', plate: '' } };

  await t.test('un robot intact est rangé', () => {
    assert.deepEqual(signauxRobotIntact(robot), ['telephone_hors_zone', 'aucun_vehicule']);
  });

  await t.test('un lead déjà travaillé n’est jamais rangé d’office', () => {
    assert.equal(signauxRobotIntact({ ...robot, manualStatus: 'contacted' }), null);
    assert.equal(signauxRobotIntact({ ...robot, notes: [{ text: 'rappelé' }] }), null);
    assert.equal(signauxRobotIntact({ ...robot, communications: [{ canal: 'email' }] }), null);
    assert.equal(signauxRobotIntact({ ...robot, manualSmsSent: 1 }), null);
  });

  await t.test('une autre source ou un vrai demandeur ne sont pas touchés', () => {
    assert.equal(signauxRobotIntact({ ...robot, captureSource: 'contact' }), null);
    assert.equal(signauxRobotIntact({ ...robot, requested: { vehicle: 'Golf 7' } }), null);
    assert.equal(signauxRobotIntact({ ...robot, phone: '0612345678' }), null);
    assert.equal(signauxRobotIntact({ ...robot, archived: true }), null);
  });
});
