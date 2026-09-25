'use strict';

/**
 * L'organisation Autoliva dans le JSON-LD : UNE seule entité, avec un @id
 * stable, reprise par l'accueil, /notre-histoire et le vendeur des fiches
 * (audit des données structurées du 25/09/2026).
 *
 * Avant : l'accueil ne déclarait que le nom, l'URL et le favicon ;
 * /notre-histoire déclarait une deuxième organisation sans lien avec la
 * première ; et chaque fiche annonçait un retour GRATUIT sous 30 jours, faux.
 * Google lit ici l'identité de l'entreprise et la politique de retour réelle,
 * déclarée une fois au niveau de l'organisation.
 *
 * Sources, à changer ICI et dans les CGV le même jour si elles bougent :
 *   - raison sociale et SIREN : registre (CAR PARTS FRANCE, 907 510 838,
 *     Nice), vérifié le 25/09/2026 ; TVA : clé du SIREN ;
 *   - adresse, téléphone, e-mail : ceux du pied de page (fr.json
 *     footer.address, config/brand.js) ;
 *   - retours : CGV art. 9 — rétractation 14 jours à compter de la réception,
 *     frais de retour à la charge du client, remboursement intégral. Les pièces
 *     programmées au VIN en sont exclues (L.221-28) : la fiche le dit.
 */

const brand = require('../config/brand');

const SIREN = '907510838';
const TVA_INTRACOM = 'FR61907510838';

function idOrganisation(baseUrl) {
  return `${baseUrl || ''}/#organization`;
}

function politiqueRetour(baseUrl) {
  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'FR',
    returnPolicyCountry: 'FR',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 14,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
    refundType: 'https://schema.org/FullRefund',
    merchantReturnLink: `${baseUrl || ''}/legal/cgv`,
  };
}

/**
 * @param {string} baseUrl  https://autoliva.com (sans barre finale)
 * @param {{ sameAs?: string[] }} [options]  réseaux saisis dans l'admin
 */
function organisationSchema(baseUrl, { sameAs = [] } = {}) {
  const liens = (Array.isArray(sameAs) ? sameAs : []).filter(Boolean);
  return {
    '@type': 'OnlineStore',
    '@id': idOrganisation(baseUrl),
    name: brand.NAME,
    legalName: (brand.COMPANY && brand.COMPANY.LEGAL_NAME) || 'Car Parts France',
    url: `${baseUrl || ''}/`,
    logo: `${baseUrl || ''}${brand.LOGO_URL}`,
    email: brand.EMAIL_CONTACT,
    telephone: brand.PHONE_INTL,
    address: {
      '@type': 'PostalAddress',
      streetAddress: '50 boulevard Stalingrad',
      postalCode: '06300',
      addressLocality: 'Nice',
      addressCountry: 'FR',
    },
    vatID: TVA_INTRACOM,
    iso6523Code: `0002:${SIREN}`,
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer service',
      telephone: brand.PHONE_INTL,
      email: brand.EMAIL_CONTACT,
      availableLanguage: ['fr'],
    },
    hasMerchantReturnPolicy: politiqueRetour(baseUrl),
    sameAs: liens.length ? liens : undefined,
  };
}

module.exports = { organisationSchema, idOrganisation, politiqueRetour, SIREN, TVA_INTRACOM };
