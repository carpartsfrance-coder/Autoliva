const mongoose = require('mongoose');
const Order = require('../models/Order');
const service = require('../services/orderProcurement');
function payload(order) {
  return { id: String(order._id), number: order.number, revision: order.procurementRevision || 0, signature: service.itemSignature(order.items), lines: service.linesFor(order), summary: service.summarize(order), customerPromisedOn: order.customerPromisedOn || '', contacts: order.procurementContacts || [], states: service.STATES, channels: service.CHANNELS, today: service.today(), readOnly: !!order.deletedAt || !!order.archived || ['cancelled','refunded','completed','delivered','shipped'].includes(order.status) };
}
async function withParcels(order) {
 const data=payload(order);
 const shipments=await require('../models/SupplierShipment').find({'links.orderId':order._id}).sort({createdAt:-1}).limit(30).lean();
 data.parcels=shipments.map(s=>({supplier:s.supplier,carrier:s.carrier,trackingNumber:s.trackingNumber,status:s.status,lastCheckedAt:s.lastCheckedAt,syncError:s.syncError,url:require('../services/supplierTracking').carrierUrl(s.carrier,s.trackingNumber),stale:s.links.some(l=>String(l.orderId)===String(order._id)&&l.signature!==data.signature)}));
 return data;
}
function createController(Model = Order, connected = () => mongoose.connection.readyState === 1) {
  async function load(req, res) {
    if (!connected()) { res.status(503).json({ok:false,error:'Base de données indisponible. Réessayez plus tard.'}); return null; }
    if (!mongoose.isValidObjectId(req.params.orderId)) { res.status(400).json({ok:false,error:'Commande invalide.'}); return null; }
    const order = await Model.findById(req.params.orderId).select('number items sourcing purchase.supplier status orderType cloningStatus customerPromisedOn procurementContacts procurementRevision archived deletedAt').lean();
    if (!order) res.status(404).json({ok:false,error:'Commande introuvable.'});
    return order;
  }
  return {
    async get(req,res,next) { try { const order = await load(req,res); if (order) res.json({ok:true,data:await withParcels(order)}); } catch(err) { next(err); } },
    async save(req,res,next) {
      try {
        if (!req.is('application/json')) return res.status(415).json({ok:false,error:'Format de requête invalide.'});
        const order = await load(req,res); if (!order) return;
        if (payload(order).readOnly) return res.status(409).json({ok:false,error:'Cette commande est en lecture seule.'});
        let data;
        try { data = service.validateUpdate(req.body, order); } catch(err) { return res.status(400).json({ok:false,error:err.message}); }
        if (req.body.revision !== (order.procurementRevision || 0) || req.body.signature !== service.itemSignature(order.items)) return res.status(409).json({ok:false,error:'La commande a été modifiée depuis son ouverture. Fermez puis rouvrez le suivi avant de réessayer.'});
        const states = data.lines.map(l => l.state);
        const sourcing = states.includes('unchecked') ? 'a_verifier' : states.includes('to_order') ? 'a_commander' : states.includes('ordered') ? 'commandee' : 'en_stock';
        const waiting = data.lines.filter(l => l.state === 'ordered');
        const dates = waiting.map(l=>l.expectedOn).filter(Boolean).sort();
        const ordered = waiting.map(l=>l.orderedOn).filter(Boolean).sort()[0] || '';
        const set = { customerPromisedOn: data.customerPromisedOn, 'sourcing.status': sourcing,
          'sourcing.orderedAt': ordered ? new Date(ordered+'T00:00:00Z') : null,
          'sourcing.expectedDays': ordered && dates.length ? Math.max(0,Math.round((Date.parse(dates[0])-Date.parse(ordered))/86400000)) : null,
          'sourcing.updatedAt':new Date() };
        data.lines.forEach((line,index) => { set[`items.${index}.procurement`] = line; });
        const update = {$set:set,$inc:{procurementRevision:1}};
        if (data.contact) {
          const admin = req.session?.admin || {};
          data.contact.createdAt = new Date();
          data.contact.author = [admin.firstName,admin.lastName].filter(Boolean).join(' ') || admin.email || 'Admin';
          update.$push = {procurementContacts:{$each:[data.contact],$slice:-100}};
        }
        const revisionQuery = order.procurementRevision === undefined ? {procurementRevision:{$exists:false}} : {procurementRevision:order.procurementRevision};
        // Compare line identity and quantity without casting whole legacy subdocuments
        // (Mongoose would inject defaults absent from older stored orders).
        const snapshot = {};
        order.items.forEach((item, index) => {
          for (const key of ['productId','name','sku','quantity','itemType']) {
            snapshot[`items.${index}.${key}`] = item[key] === undefined ? {$exists:false} : item[key];
          }
        });
        for(const key of ['status','orderedAt','expectedDays','updatedAt']) snapshot['sourcing.'+key]=order.sourcing?.[key]===undefined?{$exists:false}:order.sourcing[key];
        const saved = await Model.findOneAndUpdate({_id:order._id,...snapshot,$expr:{$eq:[{$size:'$items'},order.items.length]},status:order.status,archived:order.archived === undefined ? {$exists:false} : order.archived,deletedAt:order.deletedAt || null,...revisionQuery}, update, {new:true,runValidators:true}).lean();
        if (!saved) return res.status(409).json({ok:false,error:'Une autre modification a eu lieu. Fermez puis rouvrez le suivi ; vos changements n’ont pas été écrasés.'});
        return res.json({ok:true,data:await withParcels(saved)});
      } catch(err) { next(err); }
    }
  };
}
module.exports = {...createController(), createController, payload, withParcels};
