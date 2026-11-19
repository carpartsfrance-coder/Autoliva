/**
 * Connecteur MCP — outils leads (19/11/2026) : listLeads, getLead,
 * addLeadNote, setLeadNextAction.
 *
 * Demande de Killian : « pour récupérer les leads ou traiter, tu voudrais pas
 * utiliser le connecteur ? ». Le connecteur ne voyait que les ventes, le SAV
 * et les commandes : les leads se lisaient en pilotant le back-office dans un
 * navigateur.
 *
 * Vérifié ici :
 *  - la file rendue est celle de l'onglet « À traiter » (mêmes onglets, dont
 *    « Attente fournisseur » et « À valider ») ;
 *  - la recherche retrouve une plaque tapée avec ou sans tirets, et les
 *    dossiers clos ;
 *  - jamais de numéro de téléphone dans une réponse ;
 *  - les deux seules écritures (note, prochaine action) laissent la même trace
 *    que le back-office, n'attribuent pas le dossier et refusent un dossier
 *    clos ;
 *  - aucun outil ne touche aux autres collections.
 *
 * Lancé par : npm test (mongodb-memory-server : jamais la production).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
process.env.MCP_BEARER_TOKEN = 'jeton-de-test-mcp-leads';
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY']) process.env[cle] = '';

const TEL = '0611223344';
const TEL_FERME = '0699887766';
const JOUR = 24 * 3600 * 1000;

async function appel(dispatch, name, args) {
  const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } });
  assert.ok(r.result, `réponse JSON-RPC attendue pour ${name}`);
  return r.result;
}
const texte = (res) => res.content.map((c) => c.text || '').join('\n');
const json = (res) => JSON.parse(res.content[0].text);

test('connecteur MCP — leads : lire la file, chercher, noter, planifier', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => {
    await mongoose.disconnect();
    await serveur.stop();
  });

  const AbandonedCart = require('../../src/models/AbandonedCart');
  const { dispatch } = require('../../src/mcp/server');

  const maintenant = Date.now();
  const ranger = await AbandonedCart.create({
    sessionId: 's-mcp-ranger', captureSource: 'devis', email: 'ranger@example.com', phone: TEL,
    firstName: 'Georges', lastName: 'Simoes',
    abandonedAt: new Date(maintenant - 2 * 3600000), createdAt: new Date(maintenant - 2 * 3600000),
    lastActivityAt: new Date(maintenant - 2 * 3600000),
    requested: { plate: 'FL776JS', ref: 'Moteur Diesel GBVAJQJ 2.2 TDCi – Ford Ranger', message: 'Vérification de compatibilité par plaque (fiche produit)' },
    notes: [{ text: 'Claude 19/11 18:26 — Asysum a déjà répondu (OV071078).', addedByName: 'Killian Autoliva', addedAt: new Date(maintenant - 3600000) }],
  });
  const attente = await AbandonedCart.create({
    sessionId: 's-mcp-attente', captureSource: 'devis', email: 'attente@example.com', phone: '0622334455',
    abandonedAt: new Date(maintenant - 3 * 3600000), createdAt: new Date(maintenant - 3 * 3600000),
    lastActivityAt: new Date(maintenant - 3 * 3600000), takenByName: 'Lucas',
    requested: { plate: 'AZ319SF', vin: 'WAUZZZ8R7BA022771', ref: 'Boîte S tronic 0B5 MSH' },
    nextAction: { type: 'wait_supplier', dueAt: new Date(maintenant + JOUR), note: 'Demande de prix envoyée à Inter-matic', setByName: 'Claude', setAt: new Date() },
    communications: [{ canal: 'email', sens: 'sortant', auto: false, objet: 'Votre boîte S tronic MSH', corps: 'Nous avons vérifié votre immatriculation.', gabarit: 'devis_quote_ready', statut: 'envoye', par: 'Lucas', at: new Date(maintenant - 1800000) }],
  });
  /* Appel manqué : la plaque n'est que dans la réponse SMS, écrite à sa façon. */
  const kangoo = await AbandonedCart.create({
    sessionId: 's-mcp-kangoo', captureSource: 'appel_manque', phone: '0633445566',
    abandonedAt: new Date(maintenant - JOUR), createdAt: new Date(maintenant - JOUR), lastActivityAt: new Date(maintenant - JOUR),
    notes: [{ text: 'RÉPONSE SMS du client : « Bonjour une boite de vitesse pour un kangoo immatriculation HF.713.EA »', addedByName: 'Ringover SMS', addedAt: new Date(maintenant - JOUR) }],
  });
  const ferme = await AbandonedCart.create({
    sessionId: 's-mcp-ferme', captureSource: 'devis', email: 'ferme@example.com', phone: TEL_FERME,
    abandonedAt: new Date(maintenant - 20 * JOUR), createdAt: new Date(maintenant - 20 * JOUR),
    lastActivityAt: new Date(maintenant - 20 * JOUR), manualStatus: 'lost', lostReason: 'prix',
    requested: { plate: 'AB-123-CD', ref: 'Pont arrière' },
  });
  const nAvant = await AbandonedCart.countDocuments({});
  const autres = async () => {
    const h = crypto.createHash('sha256');
    for (const c of await mongoose.connection.db.listCollections().toArray()) {
      if (c.name === 'abandonedcarts') continue;
      const docs = await mongoose.connection.db.collection(c.name).find({}).sort({ _id: 1 }).toArray();
      h.update(c.name + ':' + JSON.stringify(docs));
    }
    return h.digest('hex');
  };
  const empreinteAutres = await autres();
  const reponses = [];
  const garder = (res) => { reponses.push(texte(res)); return res; };

  await t.test('les quatre outils leads sont déclarés, lecture et écriture annoncées', async () => {
    const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const parNom = new Map(r.result.tools.map((o) => [o.name, o]));
    for (const nom of ['getBusinessOverview', 'listSavTickets', 'getOrder', 'listLeads', 'getLead', 'addLeadNote', 'setLeadNextAction']) {
      assert.ok(parNom.has(nom), `outil ${nom} manquant`);
    }
    assert.strictEqual(parNom.get('listLeads').annotations.readOnlyHint, true);
    assert.strictEqual(parNom.get('getLead').annotations.readOnlyHint, true);
    assert.strictEqual(parNom.get('addLeadNote').annotations.readOnlyHint, false);
    assert.strictEqual(parNom.get('setLeadNextAction').annotations.readOnlyHint, false);
    assert.ok(parNom.get('setLeadNextAction').inputSchema.properties.type.enum.includes('wait_supplier'));
    const init = await dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    assert.match(init.result.instructions, /rien n'est jamais envoyé au client/);
  });

  await t.test('listLeads : la file « À traiter », onglet par onglet', async () => {
    const d = json(garder(await appel(dispatch, 'listLeads')));
    assert.strictEqual(d.counts.non_traites, 2);
    assert.strictEqual(d.counts.fournisseur, 1);
    assert.strictEqual(d.counts.a_valider, 0);
    const nonTraites = d.groups.find((g) => g.key === 'non_traites');
    /* Les plus récentes en haut, comme dans le back-office. */
    assert.deepStrictEqual(nonTraites.leads.map((l) => l.id), [String(ranger._id), String(kangoo._id)]);
    assert.strictEqual(nonTraites.leads[1].client_email, null, 'appel manqué : pas d’e-mail');
    assert.strictEqual(nonTraites.leads[1].has_phone, true);
    const l = nonTraites.leads[0];
    assert.strictEqual(l.plate, 'FL776JS');
    assert.strictEqual(l.client, 'Georges Simoes');
    assert.strictEqual(l.client_email, 'ranger@example.com');
    assert.strictEqual(l.has_phone, true);
    assert.strictEqual(l.last_note.by, 'Killian Autoliva');
    const f = d.groups.find((g) => g.key === 'fournisseur').leads[0];
    assert.strictEqual(f.id, String(attente._id));
    assert.strictEqual(f.stage_label, 'Attente fournisseur');
    assert.strictEqual(f.next_action.type, 'wait_supplier');
    assert.strictEqual(f.next_action.note, 'Demande de prix envoyée à Inter-matic');
    assert.strictEqual(f.taken_by, 'Lucas');
    assert.ok(!d.groups.some((g) => g.leads.some((x) => x.id === String(ferme._id))), 'dossier perdu hors file');
  });

  await t.test('listLeads : un seul onglet', async () => {
    const d = json(garder(await appel(dispatch, 'listLeads', { group: 'fournisseur' })));
    assert.deepStrictEqual(d.groups.map((g) => g.key), ['fournisseur']);
    assert.strictEqual(d.groups[0].leads.length, 1);
  });

  await t.test('listLeads : recherche par plaque avec ou sans tirets, dossiers clos compris', async () => {
    const a = json(garder(await appel(dispatch, 'listLeads', { search: 'FL-776-JS' })));
    assert.deepStrictEqual(a.leads.map((l) => l.id), [String(ranger._id)], 'plaque tapée avec tirets, enregistrée sans');
    const b = json(garder(await appel(dispatch, 'listLeads', { search: 'AB123CD' })));
    assert.deepStrictEqual(b.leads.map((l) => l.id), [String(ferme._id)], 'plaque tapée sans tirets, enregistrée avec');
    assert.strictEqual(b.leads[0].stage, 'perdu');
    const c = json(garder(await appel(dispatch, 'listLeads', { search: 'WAUZZZ8R7BA022771' })));
    assert.deepStrictEqual(c.leads.map((l) => l.id), [String(attente._id)], 'VIN');
    const k = json(garder(await appel(dispatch, 'listLeads', { search: 'HF713EA' })));
    assert.deepStrictEqual(k.leads.map((l) => l.id), [String(kangoo._id)], 'plaque écrite « HF.713.EA » dans la note SMS');
  });

  await t.test('getLead : notes, messages, dossier', async () => {
    const d = json(garder(await appel(dispatch, 'getLead', { id: String(ranger._id) })));
    assert.strictEqual(d.id, String(ranger._id));
    assert.strictEqual(d.notes[0].text, 'Claude 19/11 18:26 — Asysum a déjà répondu (OV071078).');
    const a = json(garder(await appel(dispatch, 'getLead', { id: String(attente._id) })));
    const mail = a.messages.find((m) => m.template === 'devis_quote_ready');
    assert.ok(mail, 'devis envoyé visible dans le journal');
    assert.strictEqual(mail.direction, 'out');
    assert.strictEqual(mail.subject, 'Votre boîte S tronic MSH');
    assert.strictEqual(a.group, 'fournisseur', 'l’attente fournisseur prime, même après un message');
    const mauvais = await appel(dispatch, 'getLead', { id: 'pas-un-id' });
    assert.strictEqual(mauvais.isError, true);
    const absent = await appel(dispatch, 'getLead', { id: new mongoose.Types.ObjectId().toString() });
    assert.strictEqual(absent.isError, true);
  });

  await t.test('addLeadNote : note interne signée, rien d’autre ne change', async () => {
    const avant = await AbandonedCart.findById(ranger._id).lean();
    const d = json(await appel(dispatch, 'addLeadNote', { id: String(ranger._id), text: 'Claude 19/11 20:50 — mister-auto : FL776JS → Ford Ranger 2.2 TDCi 160 ch, GBVAJQJ.' }));
    assert.strictEqual(d.ok, true);
    const apres = await AbandonedCart.findById(ranger._id).lean();
    assert.strictEqual(apres.notes.length, avant.notes.length + 1);
    const n = apres.notes[apres.notes.length - 1];
    assert.strictEqual(n.addedByName, 'Claude (connecteur)');
    assert.match(n.text, /GBVAJQJ/);
    assert.strictEqual(String(apres.lastActivityAt), String(avant.lastActivityAt), 'une note ne fait pas remonter le lead');
    assert.strictEqual(apres.takenByName || '', '');
    assert.strictEqual((await appel(dispatch, 'addLeadNote', { id: String(ranger._id), text: '   ' })).isError, true);
    assert.strictEqual((await appel(dispatch, 'addLeadNote', { id: new mongoose.Types.ObjectId().toString(), text: 'x' })).isError, true);
  });

  await t.test('setLeadNextAction : attente fournisseur → onglet du même nom, même trace que le back-office', async () => {
    const d = json(await appel(dispatch, 'setLeadNextAction', { id: String(ranger._id), type: 'wait_supplier', when: 'demain', note: 'Demande de prix envoyée à Asysum (Agnès)' }));
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.state.group, 'fournisseur');
    assert.strictEqual(d.state.stage_label, 'Attente fournisseur');
    assert.strictEqual(d.state.taken_by, null, 'le connecteur ne s’attribue pas le dossier');
    const l = await AbandonedCart.findById(ranger._id).lean();
    assert.strictEqual(l.nextAction.type, 'wait_supplier');
    assert.strictEqual(l.nextAction.setByName, 'Claude');
    assert.ok(new Date(l.nextAction.dueAt).getTime() > Date.now());
    const n = l.notes[l.notes.length - 1];
    assert.strictEqual(n.addedByName, 'Claude (connecteur)');
    assert.match(n.text, /^🗓 Prochaine action : Attendre la réponse du fournisseur — .* — Demande de prix envoyée à Asysum \(Agnès\)$/);
    const file = json(await appel(dispatch, 'listLeads', { group: 'fournisseur' }));
    assert.ok(file.groups[0].leads.some((x) => x.id === String(ranger._id)));
  });

  await t.test('setLeadNextAction : à valider par Killian, puis devis envoyé', async () => {
    const v = json(await appel(dispatch, 'setLeadNextAction', { id: String(ranger._id), type: 'to_validate', when: '2h' }));
    assert.strictEqual(v.state.group, 'a_valider');
    const e = json(await appel(dispatch, 'setLeadNextAction', { id: String(ranger._id), type: 'devis_envoye', note: 'Devis GBVAJQJ envoyé' }));
    assert.strictEqual(e.ok, true);
    assert.strictEqual(e.state.next_action_label, 'Relancer le devis');
    const l = await AbandonedCart.findById(ranger._id).lean();
    assert.strictEqual(l.nextAction.type, 'follow_quote');
    assert.strictEqual(l.nextAction.dueAt, null);
  });

  await t.test('setLeadNextAction : refus clairs (dossier clos, type inconnu, date passée)', async () => {
    const clos = await appel(dispatch, 'setLeadNextAction', { id: String(ferme._id), type: 'callback', when: 'demain' });
    assert.strictEqual(clos.isError, true);
    assert.match(texte(clos), /Dossier clos \(perdu\)/);
    assert.strictEqual((await AbandonedCart.findById(ferme._id).lean()).nextAction.type || '', '', 'rien posé sur le dossier clos');
    assert.strictEqual((await appel(dispatch, 'setLeadNextAction', { id: String(attente._id), type: 'envoyer_mail', when: 'demain' })).isError, true);
    assert.strictEqual((await appel(dispatch, 'setLeadNextAction', { id: String(attente._id), type: 'callback', when: '2020-01-01T10:00:00Z' })).isError, true);
    assert.strictEqual((await appel(dispatch, 'setLeadNextAction', { id: String(attente._id), type: 'callback' })).isError, true, 'quand obligatoire');
  });

  await t.test('jamais de numéro de téléphone, aucune autre collection touchée', async () => {
    for (const r of reponses) {
      assert.ok(!r.includes(TEL) && !r.includes(TEL_FERME) && !r.includes('0622334455') && !r.includes('0633445566'), 'numéro de téléphone dans une réponse');
    }
    assert.strictEqual(await AbandonedCart.countDocuments({}), nAvant, 'aucun lead créé ni supprimé');
    assert.strictEqual(await autres(), empreinteAutres, 'aucune autre collection modifiée');
  });
});
