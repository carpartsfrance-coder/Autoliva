const InvoiceSettings = require('../models/InvoiceSettings');
const { getSiteUrlFromEnv } = require('./siteUrl');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function buildEnvFallback() {
  return {
    legalName: getTrimmedString(process.env.COMPANY_LEGAL_NAME) || 'CAR PARTS FRANCE',
    address: getTrimmedString(process.env.COMPANY_ADDRESS) || 'BUREAU 3 50 BOULEVARD STALINGRAD, 06300 NICE',
    siret: getTrimmedString(process.env.COMPANY_SIRET) || '907 510 838 00028',
    vat: getTrimmedString(process.env.COMPANY_VAT) || 'FR61907510838',
    ape: getTrimmedString(process.env.COMPANY_APE) || '4532Z',
    legalForm: getTrimmedString(process.env.COMPANY_LEGAL_FORM) || 'SAS',
    capital: getTrimmedString(process.env.COMPANY_CAPITAL) || '',
    rcs: getTrimmedString(process.env.COMPANY_RCS) || '',
    website: getTrimmedString(process.env.COMPANY_WEBSITE_URL) || '',
    logoUrl: getTrimmedString(process.env.COMPANY_LOGO_URL) || '/images/logo-v2.png',

    paymentTermsText: getTrimmedString(process.env.INVOICE_PAYMENT_TERMS_TEXT) || 'Conditions de paiement : paiement comptant. Aucun escompte pour paiement anticipé.',
    latePenaltyText: getTrimmedString(process.env.INVOICE_LATE_PENALTY_TEXT) || 'Pénalités de retard : taux légal en vigueur.',
    proRecoveryFeeText: getTrimmedString(process.env.INVOICE_PRO_RECOVERY_FEE_TEXT) || 'Indemnité forfaitaire pour frais de recouvrement : 40 € (clients professionnels).',
  };
}

async function getInvoiceSettings() {
  const doc = await InvoiceSettings.findOne({ key: 'invoice' }).lean();
  return doc || null;
}

async function getInvoiceSettingsMergedWithFallback() {
  const fallback = buildEnvFallback();
  try {
    const saved = await getInvoiceSettings();
    if (!saved) return fallback;

    return {
      ...fallback,
      legalName: saved.legalName || fallback.legalName,
      address: saved.address || fallback.address,
      siret: saved.siret || fallback.siret,
      vat: saved.vat || fallback.vat,
      ape: saved.ape || fallback.ape,
      legalForm: saved.legalForm || fallback.legalForm,
      capital: saved.capital || fallback.capital,
      rcs: saved.rcs || fallback.rcs,
      website: saved.website || fallback.website,
      logoUrl: saved.logoUrl || fallback.logoUrl,
      paymentTermsText: saved.paymentTermsText || fallback.paymentTermsText,
      latePenaltyText: saved.latePenaltyText || fallback.latePenaltyText,
      proRecoveryFeeText: saved.proRecoveryFeeText || fallback.proRecoveryFeeText,
    };
  } catch (err) {
    return fallback;
  }
}

function sanitizeForm(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    legalName: getTrimmedString(b.legalName),
    address: getTrimmedString(b.address),
    siret: getTrimmedString(b.siret),
    vat: getTrimmedString(b.vat),
    ape: getTrimmedString(b.ape),
    legalForm: getTrimmedString(b.legalForm),
    capital: getTrimmedString(b.capital),
    rcs: getTrimmedString(b.rcs),
    website: getTrimmedString(b.website),
    logoUrl: getTrimmedString(b.logoUrl),
    paymentTermsText: getTrimmedString(b.paymentTermsText),
    latePenaltyText: getTrimmedString(b.latePenaltyText),
    proRecoveryFeeText: getTrimmedString(b.proRecoveryFeeText),
  };
}

async function updateInvoiceSettingsFromForm(body) {
  const data = sanitizeForm(body);

  const updated = await InvoiceSettings.findOneAndUpdate(
    { key: 'invoice' },
    { $set: { key: 'invoice', ...data } },
    { new: true, upsert: true }
  ).lean();

  return updated;
}

module.exports = {
  buildEnvFallback,
  getInvoiceSettings,
  getInvoiceSettingsMergedWithFallback,
  updateInvoiceSettingsFromForm,
};
