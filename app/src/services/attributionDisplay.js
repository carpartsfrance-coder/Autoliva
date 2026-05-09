'use strict';

// Mise en forme du sous-document Order.attribution pour l'admin.
// Pas d'I/O, fonction pure — facile à tester.

const SOURCE_LABELS = {
  google: 'Google',
  bing: 'Bing',
  yahoo: 'Yahoo',
  duckduckgo: 'DuckDuckGo',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  twitter: 'Twitter / X',
  pinterest: 'Pinterest',
  newsletter: 'Newsletter',
  email: 'Email',
};

const MEDIUM_LABELS = {
  cpc: 'Payant (clic)',
  ppc: 'Payant (clic)',
  paid: 'Payant',
  organic: 'Organique',
  social: 'Social',
  email: 'Email',
  referral: 'Référent',
  display: 'Display',
  affiliate: 'Affiliation',
  cpm: 'Payant (impression)',
  banner: 'Bannière',
};

function isEmpty(t) {
  if (!t || typeof t !== 'object') return true;
  return !t.gclid && !t.gbraid && !t.wbraid && !t.fbclid && !t.msclkid
    && !t.utmSource && !t.utmMedium && !t.utmCampaign && !t.utmContent && !t.utmTerm;
}

// Détermine la source principale humainement lisible et la couleur de badge.
function classifyTouch(t) {
  if (!t || typeof t !== 'object') {
    return { label: 'Direct / SEO', badge: 'slate', icon: 'travel_explore' };
  }
  if (t.gclid) {
    return { label: 'Google Ads', badge: 'amber', icon: 'ads_click' };
  }
  if (t.gbraid || t.wbraid) {
    return { label: 'Google Ads (iOS)', badge: 'amber', icon: 'ads_click' };
  }
  if (t.msclkid) {
    return { label: 'Microsoft Ads', badge: 'sky', icon: 'ads_click' };
  }
  if (t.fbclid) {
    return { label: 'Facebook Ads', badge: 'blue', icon: 'ads_click' };
  }
  const src = (t.utmSource || '').toLowerCase();
  const med = (t.utmMedium || '').toLowerCase();
  if (src) {
    const friendly = SOURCE_LABELS[src] || (src.charAt(0).toUpperCase() + src.slice(1));
    let badge = 'emerald';
    if (src === 'facebook' || src === 'instagram') badge = 'blue';
    else if (src === 'google' || src === 'bing') badge = 'sky';
    else if (med === 'email' || src === 'newsletter') badge = 'purple';
    return { label: friendly + (med ? ' · ' + (MEDIUM_LABELS[med] || med) : ''), badge, icon: src === 'facebook' ? 'group' : 'public' };
  }
  return { label: 'Direct / SEO', badge: 'slate', icon: 'travel_explore' };
}

function shorten(s, max = 24) {
  if (typeof s !== 'string' || !s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatTouch(t, formatDateTime) {
  if (!t || isEmpty(t)) return null;
  const cls = classifyTouch(t);
  return {
    sourceLabel: cls.label,
    badge: cls.badge,
    icon: cls.icon,
    gclid: t.gclid || '',
    gclidShort: shorten(t.gclid || '', 24),
    gbraid: t.gbraid || '',
    wbraid: t.wbraid || '',
    fbclid: t.fbclid || '',
    msclkid: t.msclkid || '',
    utmSource: t.utmSource || '',
    utmMedium: t.utmMedium || '',
    utmCampaign: t.utmCampaign || '',
    utmContent: t.utmContent || '',
    utmTerm: t.utmTerm || '',
    landingPath: t.landingPath || '',
    landingPathShort: shorten(t.landingPath || '', 60),
    referrer: t.referrer || '',
    capturedAt: t.capturedAt && formatDateTime ? formatDateTime(t.capturedAt) : '',
  };
}

// Helper principal : transforme order.attribution en objet prêt pour la vue.
//
// @param {Object} attribution - le sous-document Order.attribution (peut être null)
// @param {Function} [formatDateTime] - fn (Date) => string FR
// @returns {Object}
function formatAttribution(attribution, formatDateTime) {
  if (!attribution || typeof attribution !== 'object') {
    return { hasAttribution: false };
  }
  const first = formatTouch(attribution.firstTouch, formatDateTime);
  const last = formatTouch(attribution.lastTouch, formatDateTime);

  if (!first && !last) {
    return { hasAttribution: false };
  }

  // Le badge "principal" affiché dans la liste = celui du dernier clic (lastTouch)
  // car c'est celui qui a directement converti. Si absent, on prend firstTouch.
  const primary = last || first;

  return {
    hasAttribution: true,
    primary: {
      sourceLabel: primary.sourceLabel,
      badge: primary.badge,
      icon: primary.icon,
      campaign: primary.utmCampaign,
      campaignShort: shorten(primary.utmCampaign, 22),
      gclid: primary.gclid,
    },
    firstTouch: first,
    lastTouch: last,
    ga4ClientId: attribution.ga4ClientId || '',
    uploadedToGoogleAdsAt: attribution.uploadedToGoogleAdsAt || null,
    googleAdsConversionId: attribution.googleAdsConversionId || '',
    uploadError: attribution.uploadError || '',
  };
}

module.exports = {
  formatAttribution,
  classifyTouch,
};
