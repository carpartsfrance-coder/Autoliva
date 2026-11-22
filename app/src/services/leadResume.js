'use strict';

/**
 * « Quelle pièce, pour quel véhicule ? » en deux morceaux courts, pour la
 * liste et la fiche de /admin/activite-panier.
 *
 * Les formulaires rangent l'information à des endroits différents : les
 * landings mettent la pièce dans `requested.vehicle` et la répètent dans le
 * message (« Pièce demandée : … ») ; la fiche produit la met dans `ref` ; un
 * appel manqué n'a souvent que la réponse SMS du client dans les notes. On la
 * retrouve où qu'elle soit, sans rien inventer.
 */

/** Pièce par défaut selon le formulaire, quand le client n'a rien précisé. */
const PIECE_PAR_SOURCE = {
  landing_moteurs: 'Moteur',
  landing_boites: 'Boîte de vitesses',
  landing_ponts: 'Pont / boîte de transfert',
  landing_5places: 'Transformation 2 → 5 places',
  landing_suspension: 'Suspension pneumatique',
  appel_manque: 'Appel manqué',
};

/** Mots qui ne disent rien du véhicule (valeurs par défaut des formulaires). */
const VEHICULE_VIDE = /^(occasion|reconditionn[ée]e?s?|neuf|neuve|standard|—|-)$/i;

/**
 * Résumé en deux morceaux pour la liste et la fiche : QUELLE pièce, POUR QUEL
 * véhicule. Les formulaires rangent l'information à des endroits différents
 * (les landings mettent la pièce dans « véhicule » et répètent « Pièce
 * demandée : … » dans le message) : on la retrouve où qu'elle soit.
 */
function resumeDemande(c) {
  const r = c.requested || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const eq = c.engineQuote || {};
  const ident = eq.identifiedEngine || {};
  const msg = String(r.message || '');
  const m = msg.match(/Pi[eè]ce demand[ée]e\s*:\s*([^\n]+)/i);
  const vehiculeBrut = String(r.vehicle || '').trim();
  const vehiculeEstPiece = /reconditionn|[ée]change standard|pont|bo[iî]te|moteur|m[ée]catronique|diff[ée]rentiel/i.test(vehiculeBrut)
    && !/\b(19|20)\d{2}\b/.test(vehiculeBrut);
  /* Sur les landings, `ref` est le numéro du dossier devis (AUT-2026-11-…),
     pas une pièce. */
  const ref = String(r.ref || '').trim();
  const refEstDossier = /^AUT-\d{4}-/i.test(ref) || ['landing_moteurs', 'landing_boites', 'landing_ponts'].includes(c.captureSource || '');
  let piece = (m && m[1].trim()) || (refEstDossier ? '' : ref)
    || (vehiculeEstPiece ? vehiculeBrut.replace(/\s*[—-]\s*échange standard$/i, '').replace(/\s+reconditionn[ée]e?(\(e\))?s?$/i, '') : '')
    || (items[0] && items[0].name) || '';
  if (!piece && msg) piece = msg.split('\n')[0].slice(0, 80);
  if (!piece) piece = PIECE_PAR_SOURCE[c.captureSource] || '';
  /* Dernière note entrante (réponse SMS d'un appel manqué) : souvent la seule trace du besoin. */
  let pieceDuSms = false;
  if (c.captureSource === 'appel_manque' && piece === PIECE_PAR_SOURCE.appel_manque) {
    const notes = Array.isArray(c.notes) ? c.notes : [];
    const sms = notes.slice().reverse().find((n) => /R[ÉE]PONSE SMS/i.test(String(n && n.text || '')));
    if (sms) {
      const t = String(sms.text).replace(/^.*?[«"]\s*/, '').replace(/\s*[»"]\s*$/, '');
      if (t) { piece = t.slice(0, 90); pieceDuSms = true; }
    }
  }
  const morceaux = [];
  if (ident.model) morceaux.push(ident.model + (ident.code ? ` (${ident.code})` : ''));
  else if (vehiculeBrut && !vehiculeEstPiece && !VEHICULE_VIDE.test(vehiculeBrut)) morceaux.push(vehiculeBrut);
  return {
    piece,
    /* La « pièce » n'est que le début du SMS du client : utile sur la ligne
       de la liste, faute de mieux, mais la fiche l'affiche comme un message
       et ne doit pas le répéter sous « Pièce ». */
    pieceDuSms,
    vehicule: morceaux.join(' · '),
    plaque: String(r.plate || '').trim(),
    vin: String(r.vin || '').trim(),
  };
}

module.exports = { resumeDemande };
