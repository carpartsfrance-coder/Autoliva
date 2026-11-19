'use strict';

const AbandonedCart = require('../../models/AbandonedCart');
const { compactJson } = require('../util/sav');
const { CONNECTEUR, isLeadId } = require('../util/leads');

const MAX_TEXTE = 2000;

const definition = {
  name: 'addLeadNote',
  description:
    "Ajoute une note interne sur un lead d'Autoliva (visible par l'équipe dans le back-office, jamais par le client). Signée « Claude (connecteur) ». À utiliser pour garder la trace de ce qui a été fait : véhicule décodé, code moteur ou boîte, demande de prix envoyée (à qui, quand), réponse du fournisseur, prix et marge. N'envoie rien au client et ne change pas l'étape du dossier (pour ça : setLeadNextAction).",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Identifiant du lead (24 caractères).' },
      text: { type: 'string', description: `Texte de la note (${MAX_TEXTE} caractères au plus).` },
    },
    required: ['id', 'text'],
    additionalProperties: false,
  },
  annotations: { title: 'Ajouter une note interne', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

async function handler(args = {}) {
  if (!isLeadId(args.id)) throw new Error('Identifiant de lead invalide (24 caractères hexadécimaux attendus).');
  const text = String(args.text || '').trim().slice(0, MAX_TEXTE);
  if (!text) throw new Error('Texte de la note vide.');
  const now = new Date();
  /* Comme la note du back-office : pas de lastActivityAt, une note interne ne
     doit pas faire remonter le lead (le tri suit l'activité du CLIENT). */
  const r = await AbandonedCart.updateOne(
    { _id: args.id.trim() },
    { $push: { notes: { text, addedBy: CONNECTEUR.id, addedByName: CONNECTEUR.nom, addedAt: now } } },
  );
  if (!r.matchedCount) throw new Error('Lead introuvable.');
  return compactJson({ ok: true, id: args.id.trim(), note: { at: now.toISOString(), by: CONNECTEUR.nom, text } });
}

module.exports = { definition, handler, MAX_TEXTE };
