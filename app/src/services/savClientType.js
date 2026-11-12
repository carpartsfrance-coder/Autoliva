'use strict';

/**
 * Résolution du type de client d'un ticket SAV : professionnel (B2B) ou particulier (B2C).
 *
 * Contexte : `SavTicket` ne porte AUCUNE référence vers `User` (les tickets peuvent être
 * ouverts en invité). Le type se déduit donc par rapprochement, dans cet ordre :
 *
 *   1. `client.email` → `User.email`  ................ chemin principal (~90 % des cas)
 *   2. `numeroCommande` → `Order`
 *        a. `vat.reverseCharge === true` .............. preuve directe de B2B (autoliquidation)
 *        b. `Order.userId` → `User.accountType` ....... repli
 *   3. sinon → 'inconnu' (on ne devine pas)
 *
 * On ne renvoie JAMAIS 'B2C' par défaut : un type non résolu reste 'inconnu', sinon on
 * masquerait des pros derrière la valeur par défaut du schéma — exactement le défaut
 * qui rendait le champ inexploitable jusqu'ici.
 */

const B2B = 'B2B';
const B2C = 'B2C';
const INCONNU = 'inconnu';

/** Traduit User.accountType ('pro' | 'particulier') vers le vocabulaire du ticket. */
function fromAccountType(accountType) {
  if (accountType === 'pro') return B2B;
  if (accountType === 'particulier') return B2C;
  return null;
}

/**
 * @param {Object} p
 * @param {string} [p.email]           email saisi sur le ticket
 * @param {string} [p.numeroCommande]  numéro de commande éventuel
 * @returns {Promise<{ type: 'B2B'|'B2C'|'inconnu', source: string }>}
 */
async function resolveClientType({ email, numeroCommande } = {}) {
  const User = require('../models/User');
  const Order = require('../models/Order');

  // 1) Par email — le plus fiable, et disponible sur tous les tickets (champ requis).
  const mail = String(email || '').trim().toLowerCase();
  if (mail) {
    try {
      const u = await User.findOne({ email: mail }).select('accountType').lean();
      const t = u && fromAccountType(u.accountType);
      if (t) return { type: t, source: 'email' };
    } catch (_) { /* on continue sur le repli */ }
  }

  // 2) Par la commande.
  const num = String(numeroCommande || '').trim();
  if (num) {
    try {
      const o = await Order.findOne({ orderNumber: num }).select('userId vat.reverseCharge').lean();
      if (o) {
        // 2a) L'autoliquidation TVA n'est possible qu'entre assujettis : c'est une preuve.
        if (o.vat && o.vat.reverseCharge === true) return { type: B2B, source: 'reverseCharge' };
        // 2b) Repli sur le compte porteur de la commande.
        if (o.userId) {
          const u2 = await User.findById(o.userId).select('accountType').lean();
          const t2 = u2 && fromAccountType(u2.accountType);
          if (t2) return { type: t2, source: 'commande' };
        }
      }
    } catch (_) { /* ignoré : on retombe sur inconnu */ }
  }

  return { type: INCONNU, source: 'non_resolu' };
}

module.exports = { resolveClientType, B2B, B2C, INCONNU };
