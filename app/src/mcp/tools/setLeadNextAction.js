'use strict';

const { poserProchaineAction, DEVIS_ENVOYE } = require('../../controllers/leadWorkController');
const { TYPES_ACTION } = require('../../services/leadWork');
const { compactJson, iso } = require('../util/sav');
const { CONNECTEUR, isLeadId } = require('../util/leads');

const TYPES = [...Object.keys(TYPES_ACTION), DEVIS_ENVOYE];
const RACCOURCIS = ['1h', '2h', 'aprem', 'demain', '2j', '5j', '1sem', '2sem', '1mois'];

const definition = {
  name: 'setLeadNextAction',
  description:
    "Pose la prochaine action d'un lead d'Autoliva, exactement comme le bouton « Planifier » du back-office : le lead change d'onglet dans la file « À traiter » et une note « Prochaine action : … » s'ajoute à son historique. N'envoie rien au client. Types : wait_supplier = prix demandé au fournisseur, réponse attendue (onglet « Attente fournisseur ») ; to_validate = Killian doit décider (onglet « À valider ») ; devis_envoye = le devis vient de partir (relance proposée à +3 jours ouvrés, sans `when`) ; callback = rappeler le client ; quote = préparer le devis ; sourcing = chercher la pièce ; follow_quote = relancer le devis ; wait_client = le client doit envoyer des infos ; payment = vérifier le paiement ; other = autre. `when` : 1h, 2h, aprem, demain (prochain jour ouvré 9 h 30), 2j, 5j, 1sem, 2sem, 1mois, ou une date ISO à venir. Refusé sur un dossier gagné ou perdu. Ne change pas qui suit le dossier.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Identifiant du lead (24 caractères).' },
      type: { type: 'string', enum: TYPES, description: 'La prochaine action.' },
      when: { type: 'string', description: `Quand : ${RACCOURCIS.join(', ')}, ou une date ISO 8601 à venir. Inutile pour devis_envoye.` },
      note: { type: 'string', description: 'Précision courte (1 000 caractères au plus), ex. « Demande de prix envoyée à Asysum (Agnès) ».' },
    },
    required: ['id', 'type'],
    additionalProperties: false,
  },
  annotations: { title: 'Poser la prochaine action', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

async function handler(args = {}) {
  if (!isLeadId(args.id)) throw new Error('Identifiant de lead invalide (24 caractères hexadécimaux attendus).');
  const r = await poserProchaineAction(
    args.id.trim(),
    { type: args.type, quand: args.when, note: args.note },
    CONNECTEUR,
    /* Le connecteur ne s'attribue pas le dossier : il reste à la personne
       qui le suit (ou « non attribué ») — c'est elle qui rappelle le client. */
    { prendre: false, refuserClos: true },
  );
  if (r.status !== 200) throw new Error(r.body.error || `Refusé (${r.status}).`);
  const e = r.body.etat || {};
  return compactJson({
    ok: true,
    id: args.id.trim(),
    message: r.body.message,
    state: {
      stage: e.stage || null,
      stage_label: e.stageLabel || null,
      group: e.group || null,
      urgency: e.urgence || null,
      due_at: iso(e.dueAt),
      next_action_label: e.nextActionLabel || null,
      taken_by: e.takenByName || null,
    },
  });
}

module.exports = { definition, handler, TYPES, RACCOURCIS };
