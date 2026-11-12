/**
 * L'organisation déclarée à Google (services/organisationSchema.js) — audit
 * des données structurées du 25/09/2026. Elle porte l'identité légale et la
 * politique de retour RÉELLE (CGV art. 9) : si l'une change sans l'autre, le
 * balisage redevient une fausse déclaration. Ce test fige ce que disent les CGV.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.BRAND = 'autoliva';
const { organisationSchema, idOrganisation, politiqueRetour } = require('../../src/services/organisationSchema');

const BASE = 'https://autoliva.com';

test('une seule organisation, avec un @id stable, repris par le vendeur des fiches', () => {
  const org = organisationSchema(BASE);
  assert.equal(org['@id'], 'https://autoliva.com/#organization');
  assert.equal(idOrganisation(BASE), org['@id']);
  assert.equal(org['@type'], 'OnlineStore');
});

test('identité : raison sociale, SIREN, TVA, adresse et contact du pied de page', () => {
  const org = organisationSchema(BASE);
  assert.equal(org.name, 'Autoliva');
  assert.equal(org.legalName, 'Car Parts France');
  assert.equal(org.iso6523Code, '0002:907510838');
  assert.equal(org.vatID, 'FR61907510838');
  assert.deepEqual(
    [org.address.streetAddress, org.address.postalCode, org.address.addressLocality, org.address.addressCountry],
    ['50 boulevard Stalingrad', '06300', 'Nice', 'FR'],
  );
  assert.equal(org.email, 'contact@autoliva.com');
  assert.equal(org.telephone, '+33465845488');
  assert.equal(org.logo, 'https://autoliva.com/images/logo-autoliva.png', 'le vrai logo, pas le favicon');
});

test('retours : 14 jours, frais à la charge du client, remboursement intégral (CGV art. 9)', () => {
  const r = politiqueRetour(BASE);
  assert.equal(r.merchantReturnDays, 14);
  assert.equal(r.returnFees, 'https://schema.org/ReturnFeesCustomerResponsibility');
  assert.equal(r.refundType, 'https://schema.org/FullRefund');
  assert.equal(r.returnPolicyCategory, 'https://schema.org/MerchantReturnFiniteReturnWindow');
  assert.equal(r.merchantReturnLink, 'https://autoliva.com/legal/cgv');
  assert.ok(!JSON.stringify(r).includes('FreeReturn'), 'jamais « retour gratuit »');
});

test('réseaux : seulement ceux saisis dans l’admin, rien sinon', () => {
  assert.equal(organisationSchema(BASE).sameAs, undefined);
  assert.deepEqual(organisationSchema(BASE, { sameAs: ['https://www.youtube.com/@autoliva', ''] }).sameAs, ['https://www.youtube.com/@autoliva']);
});
