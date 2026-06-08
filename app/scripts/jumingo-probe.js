'use strict';
/* Sonde l'API JUMiNGO sur un VRAI numéro de suivi et affiche la réponse brute
 * + le statut tel que notre code l'interprète. À lancer UNE fois pour valider
 * la forme de la réponse avant d'activer la synchro auto (JUMINGO_SYNC_ENABLED).
 *
 * Usage (depuis le dossier app) :
 *   JUMINGO_API_KEY="..." node scripts/jumingo-probe.js <numero_de_suivi>
 */
const jumingo = require('../src/services/jumingo');

(async () => {
  const tn = process.argv[2];
  if (!process.env.JUMINGO_API_KEY) throw new Error('JUMINGO_API_KEY manquante (ex: JUMINGO_API_KEY="..." node scripts/jumingo-probe.js <suivi>)');
  if (!tn) throw new Error('Usage : node scripts/jumingo-probe.js <numero_de_suivi>');

  console.log('Base      :', jumingo.BASE_URL);
  console.log('Recherche :', tn, '\n');

  const raw = await jumingo._internal.apiGet('/shipments?search=' + encodeURIComponent(tn));
  console.log('HTTP', raw.httpStatus);
  console.log('--- réponse brute (2000 premiers caractères) ---');
  console.log((raw.rawText || '(vide)').slice(0, 2000));

  console.log('\n--- interprétation par notre mapping ---');
  const r = await jumingo.getTrackingStatus(tn);
  console.log(JSON.stringify(r, null, 2));
  console.log('\n→ Statut transporteur brut :', r.rawStatus || '—');
  console.log('→ La commande serait classée :', r.status,
    r.status === 'shipped' ? '(= vraiment partie)' :
    r.status === 'label_created' ? '(= étiquette seule, pas encore partie)' :
    r.status === 'delivered' ? '(= livrée)' : '');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
