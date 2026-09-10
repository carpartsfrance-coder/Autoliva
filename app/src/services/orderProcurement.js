const { createHash } = require('node:crypto');
const STATES = { unchecked: 'À vérifier', in_stock: 'En stock chez nous', to_order: 'À commander', ordered: 'Commandée fournisseur', received: 'Reçue chez nous', not_required: 'Service / sans achat' };
const CHANNELS = { phone: 'Téléphone', email: 'Email', whatsapp: 'WhatsApp' };
function today(date = new Date()) { return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }); }
function itemSignature(items) {
  return createHash('sha256').update(JSON.stringify((items || []).map(i => [String(i.productId || ''), i.name, i.sku || '', i.quantity, i.itemType || '']))).digest('hex');
}
function linesFor(order) {
  return (order.items || []).map((item, index) => ({ index, name: item.name, sku: item.sku || '', quantity: item.quantity,
    state: item.procurement?.state || (item.itemType === 'standalone_cloning' ? 'not_required' : ({a_verifier:'unchecked',a_commander:'to_order',commandee:'ordered',en_stock:'in_stock'}[order.sourcing?.status] || 'unchecked')),
    supplier: item.procurement?.supplier || order.purchase?.supplier || '', orderedOn: item.procurement?.orderedOn || (order.sourcing?.orderedAt ? today(new Date(order.sourcing.orderedAt)) : ''), expectedOn: item.procurement?.expectedOn || (order.sourcing?.orderedAt && order.sourcing?.expectedDays > 0 ? today(new Date(new Date(order.sourcing.orderedAt).getTime()+order.sourcing.expectedDays*86400000)) : '') }));
}
function summarize(order, date = today()) {
  const lines = linesFor(order);
  const physical = lines.filter(i => i.state !== 'not_required');
  const available = physical.filter(i => ['in_stock', 'received'].includes(i.state)).reduce((n, i) => n + i.quantity, 0);
  const total = physical.reduce((n, i) => n + i.quantity, 0);
  const toCheck = physical.some(i => i.state === 'unchecked');
  const toOrder = physical.some(i => i.state === 'to_order');
  const supplierLate = physical.some(i => i.state === 'ordered' && i.expectedOn && i.expectedOn < date);
  const terminal = ['shipped', 'delivered', 'completed', 'cancelled', 'refunded'].includes(order.status);
  const customerLate = !terminal && !!order.customerPromisedOn && order.customerPromisedOn < date;
  const complete = lines.length > 0 && physical.every(i => ['in_stock', 'received'].includes(i.state));
  const cloningRequired = ['exchange_cloning', 'standalone_cloning'].includes(order.orderType) || lines.some((_, i) => ['exchange_cloning', 'standalone_cloning'].includes(order.items[i].itemType));
  const ready = !terminal && ['paid','processing','label_created'].includes(order.status) && complete && (!cloningRequired || order.cloningStatus === 'cloning_done');
  const next = terminal ? 'Consulter le suivi' : toCheck ? 'Vérifier le stock' : toOrder ? 'Commander les pièces' : !complete ? 'Attendre la réception' : !['paid','processing','label_created'].includes(order.status) ? 'Vérifier le paiement' : !ready ? 'Terminer le clonage' : 'Préparer l’expédition';
  return { available, total, ready, supplierLate: !terminal && supplierLate, customerLate, next, label: ready ? 'Prête à expédier' : total ? `${available}/${total} pièces disponibles` : 'Sans achat fournisseur', lines, lastContact: (order.procurementContacts || []).slice(-1)[0] || null };
}
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} invalide.`);
  return value.trim();
}
function dateValue(value, label) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${label} invalide.`);
  return value;
}
function validateUpdate(body, order) {
  if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.signature !== 'string') throw new Error('Version du suivi invalide.');
  if (!Array.isArray(body.lines) || body.lines.length !== order.items.length) throw new Error('La liste des pièces a changé. Rechargez le suivi.');
  const lines = body.lines.map((line, index) => {
    if (!line || line.index !== index || !Object.hasOwn(STATES, line.state)) throw new Error('État de pièce invalide.');
    const supplier = text(line.supplier, 160, 'Fournisseur');
    const orderedOn = dateValue(line.orderedOn, 'Date de commande');
    const expectedOn = dateValue(line.expectedOn, 'Date de réception prévue');
    if (line.state === 'ordered' && (!supplier || !orderedOn)) throw new Error(`Pièce ${index + 1} : renseignez le fournisseur et la date de commande.`);
    if (orderedOn && expectedOn && expectedOn < orderedOn) throw new Error(`Pièce ${index + 1} : la réception prévue précède la commande.`);
    return { state: line.state, supplier, orderedOn, expectedOn };
  });
  const customerPromisedOn = dateValue(body.customerPromisedOn, 'Date annoncée au client');
  let contact = null;
  if (body.contact) {
    if (!Object.hasOwn(CHANNELS, body.contact.channel)) throw new Error('Canal de contact invalide.');
    const note = text(body.contact.note, 2000, 'Compte rendu');
    const on = dateValue(body.contact.on, 'Date du contact');
    if (!note || !on || on > today()) throw new Error('Renseignez un compte rendu et une date de contact non future.');
    contact = { channel: body.contact.channel, note, on };
  }
  return { lines, customerPromisedOn, contact };
}
module.exports = { STATES, CHANNELS, today, itemSignature, linesFor, summarize, validateUpdate };

// One shared predicate for filters and counters, including older per-order records.
function sourcingQuery(filter, date = today()) {
 const legacyOnly={'items.procurement.state':{$exists:false}};
 let modern,legacy;
 const map={a_commander:'to_order',commandee:'ordered',a_verifier:'unchecked'};
 if(map[filter]){
  modern={items:{$elemMatch:{'procurement.state':map[filter]}}};
  legacy=filter==='a_verifier'?{$or:[{'sourcing.status':'a_verifier'},{'sourcing.status':null}]}:{'sourcing.status':filter};
 }else if(filter==='en_stock'){
  modern={$and:[{'items.0':{$exists:true}},{'items.procurement.state':{$exists:true}},{items:{$not:{$elemMatch:{'procurement.state':{$nin:['in_stock','received','not_required']}}}}}]};legacy={'sourcing.status':'en_stock'};
 }else if(filter==='overdue'){
  modern={items:{$elemMatch:{'procurement.state':'ordered','procurement.expectedOn':{$gt:'',$lt:date}}}};
  legacy={'sourcing.status':'commandee','sourcing.orderedAt':{$ne:null},'sourcing.expectedDays':{$gt:0},$expr:{$lt:[{$add:['$sourcing.orderedAt',{$multiply:['$sourcing.expectedDays',86400000]}]},new Date(date+'T00:00:00Z')]}};
 }else return {};
 return {$or:[modern,{$and:[legacyOnly,legacy]}]};
}
module.exports.sourcingQuery=sourcingQuery;
