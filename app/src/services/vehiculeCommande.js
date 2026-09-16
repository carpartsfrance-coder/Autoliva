'use strict';

/**
 * Plaque et VIN d'une commande, prêts à afficher dans l'admin (panneau de la
 * liste des commandes).
 *
 * Deux sources :
 *   1. `order.vehicle`, saisi par le client au paiement (308 commandes sur 354
 *      au 16/09/2026). Le paiement ne garde que lettres et chiffres, et le
 *      champ « plaque » contient parfois un VIN, ou la plaque ET le VIN
 *      (« DW038XFVINWVWZZZAUZFP043058 ») : on les remet chacun à sa place.
 *      Ce qui ne se reconnaît pas est rendu tel que saisi, sans prétendre
 *      que c'est une plaque (`saisie`).
 *   2. À défaut, le texte des articles des commandes saisies à la main (devis
 *      moteur, téléphone) : « Immat : DP401HF », « VIN : WAUZZZ8R4GA091182 ».
 */

const { formatPlate } = require('./plateLookup');

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const SIV = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
/* « VIN » et « IMMAT » ne peuvent pas faire partie d'un VIN (pas de I). */
const PLAQUE_PUIS_VIN = /^([A-Z]{2}\d{3}[A-Z]{2})(?:VIN)?([A-HJ-NPR-Z0-9]{17})$/;
const VIN_PUIS_PLAQUE = /^([A-HJ-NPR-Z0-9]{17})(?:IM+AT(?:RICULATION)?)?([A-Z]{2}\d{3}[A-Z]{2})$/;
const IMMAT_DANS_TEXTE = /immat(?:riculation)?\s*:\s*([A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2})(?![A-Z0-9])/i;
const VIN_DANS_TEXTE = /\bVIN\s*:\s*([A-HJ-NPR-Z0-9]{17})(?![A-Z0-9])/i;

function compact(valeur) {
  return String(valeur == null ? '' : valeur).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** @returns {{ plaque: string, vin: string, saisie: string }} chaînes vides si inconnus */
function identifiantsVehicule(order) {
  const v = (order && order.vehicle) || {};
  let plaque = '';
  let vin = '';
  let saisie = '';

  const vinSaisi = String(v.vin == null ? '' : v.vin).trim();
  if (vinSaisi) vin = VIN.test(compact(vinSaisi)) ? compact(vinSaisi) : vinSaisi.toUpperCase();

  const plaqueSaisie = String(v.plate == null ? '' : v.plate).trim();
  const c = compact(plaqueSaisie);
  if (c) {
    const plaqueVin = c.match(PLAQUE_PUIS_VIN);
    const vinPlaque = c.match(VIN_PUIS_PLAQUE);
    if (SIV.test(c)) {
      plaque = formatPlate(c);
    } else if (VIN.test(c)) {
      if (!vin) vin = c; // un VIN tapé dans le champ plaque
    } else if (plaqueVin) {
      plaque = formatPlate(plaqueVin[1]);
      if (!vin) vin = plaqueVin[2];
    } else if (vinPlaque) {
      plaque = formatPlate(vinPlaque[2]);
      if (!vin) vin = vinPlaque[1];
    } else {
      saisie = plaqueSaisie.toUpperCase(); // ancien format, étranger, texte libre
    }
  }

  if (!plaque && !vin && !saisie) {
    const texte = (Array.isArray(order && order.items) ? order.items : [])
      .map((it) => (it ? [it.sku, it.name, it.optionsSummary].filter(Boolean).join(' ') : ''))
      .join(' ');
    const immat = texte.match(IMMAT_DANS_TEXTE);
    const numeroSerie = texte.match(VIN_DANS_TEXTE);
    if (immat) plaque = formatPlate(immat[1]);
    if (numeroSerie) vin = numeroSerie[1].toUpperCase();
  }

  return { plaque, vin, saisie };
}

module.exports = { identifiantsVehicule };
