function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTrackingNumber(value) {
  return getTrimmedString(value).replace(/\s+/g, '');
}

function buildCarrierTrackingUrl(carrierLabel, trackingNumber) {
  const tracking = normalizeTrackingNumber(trackingNumber);
  if (!tracking) return '';

  const rawCarrier = getTrimmedString(carrierLabel).toLowerCase();

  if (tracking.toUpperCase().startsWith('1Z') || rawCarrier.includes('ups')) {
    return `https://www.ups.com/track?loc=fr_FR&tracknum=${encodeURIComponent(tracking)}`;
  }

  if (rawCarrier.includes('colissimo') || rawCarrier.includes('la poste') || rawCarrier.includes('laposte')) {
    return `https://www.laposte.fr/outils/suivre-vos-envois?code=${encodeURIComponent(tracking)}`;
  }

  if (rawCarrier.includes('chronopost')) {
    return `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${encodeURIComponent(tracking)}`;
  }

  if (rawCarrier.includes('mondial') || rawCarrier.includes('relay')) {
    return `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${encodeURIComponent(tracking)}`;
  }

  if (rawCarrier.includes('dpd')) {
    return `https://tracking.dpd.fr/${encodeURIComponent(tracking)}`;
  }

  if (rawCarrier.includes('gls')) {
    return `https://gls-group.com/FR/fr/suivi-colis/?match=${encodeURIComponent(tracking)}`;
  }

  if (rawCarrier.includes('dhl')) {
    return `https://www.dhl.com/fr-fr/home/tracking.html?tracking-id=${encodeURIComponent(tracking)}`;
  }

  return '';
}

module.exports = {
  normalizeTrackingNumber,
  buildCarrierTrackingUrl,
};
