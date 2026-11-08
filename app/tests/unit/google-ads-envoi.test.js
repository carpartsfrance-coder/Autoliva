/**
 * Ce qui part réellement chez Google (Data Manager API, events:ingest) :
 * identifiant de transaction et valeur — y compris la valeur 0 d'une vente
 * remboursée. `fetch` est remplacé : aucun appel réseau.
 *
 * Référence : un 2e envoi avec le même transactionId, dans la même action de
 * conversion, est traité par Google comme une correction du 1er —
 * https://developers.google.com/data-manager/api/devguides/events/google-ads/conversion-adjustments
 */

const test = require('node:test');
const assert = require('node:assert');

const ENV = {
  GOOGLE_ADS_CLIENT_ID: 'id-test',
  GOOGLE_ADS_CLIENT_SECRET: 'secret-test',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh-test',
  GOOGLE_ADS_CUSTOMER_ID: '956-259-8225',
  GOOGLE_ADS_SALE_ACTION: '7681529039',
  GOOGLE_ADS_PURCHASE_ACTION: '7681589453',
  GOOGLE_ADS_LEAD_ACTION: '',
  GOOGLE_ADS_QUOTE_ACTION: '',
};

test('envoi Data Manager : identifiant de transaction et valeur', async (t) => {
  const avant = {};
  for (const [k, v] of Object.entries(ENV)) { avant[k] = process.env[k]; process.env[k] = v; }
  const vraiFetch = global.fetch;
  const corps = [];
  global.fetch = async (url, options) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, json: async () => ({ access_token: 'jeton', expires_in: 3600 }) };
    }
    corps.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ requestId: 'r1' }) };
  };
  t.after(() => {
    global.fetch = vraiFetch;
    for (const [k, v] of Object.entries(avant)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const gAds = require('../../src/services/googleAdsConversions');

  await t.test('vente après demande de devis : clic de la demande, marge, n° de commande', async () => {
    corps.length = 0;
    const r = await gAds.uploadConversion({
      gclid: 'GCLID-1', action: 'sale', value: 1549.999, dateTime: new Date('2026-11-04T10:00:00Z'), transactionId: 'CP2026-000831',
    });
    assert.strictEqual(r.ok, true);
    const p = corps[0];
    assert.strictEqual(p.destinations[0].productDestinationId, '7681529039');
    assert.strictEqual(p.destinations[0].operatingAccount.accountId, '9562598225');
    const ev = p.events[0];
    assert.strictEqual(ev.transactionId, 'CP2026-000831');
    assert.strictEqual(ev.conversionValue, 1550);
    assert.strictEqual(ev.currency, 'EUR');
    assert.deepStrictEqual(ev.adIdentifiers, { gclid: 'GCLID-1' });
    assert.strictEqual(ev.eventTimestamp, '2026-11-04T10:00:00Z');
    assert.strictEqual(ev.userData, undefined, 'aucune donnée personnelle sans e-mail ni téléphone');
    assert.strictEqual(p.encoding, undefined);
  });

  await t.test('correction à 0 (vente remboursée) : la valeur 0 part explicitement', async () => {
    corps.length = 0;
    await gAds.uploadConversion({ gclid: 'GCLID-1', action: 'purchase', value: 0, valeurExplicite: true, dateTime: new Date('2026-11-04T10:00:00Z'), transactionId: 'CP2026-000785' });
    const ev = corps[0].events[0];
    assert.strictEqual(corps[0].destinations[0].productDestinationId, '7681589453');
    assert.strictEqual(ev.transactionId, 'CP2026-000785');
    assert.strictEqual(ev.conversionValue, 0);
    assert.strictEqual(ev.currency, 'EUR');
  });

  await t.test('sans valeur explicite, 0 reste « sans valeur » (comportement d\'avant)', async () => {
    corps.length = 0;
    await gAds.uploadConversion({ gclid: 'GCLID-1', action: 'purchase', value: 0 });
    const ev = corps[0].events[0];
    assert.strictEqual('conversionValue' in ev, false);
    assert.strictEqual('transactionId' in ev, false);
  });

  await t.test('essai à blanc : validateOnly', async () => {
    corps.length = 0;
    await gAds.uploadConversion({ gclid: 'GCLID-1', action: 'sale', value: 10, dryRun: true, transactionId: 'X' });
    assert.strictEqual(corps[0].validateOnly, true);
  });
});
