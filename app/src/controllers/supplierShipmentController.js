const mongoose=require('mongoose');
const Order=require('../models/Order');const Shipment=require('../models/SupplierShipment');
const procurement=require('../services/orderProcurement');const tracking=require('../services/supplierTracking');
const ACTIVE=['paid','processing','label_created'];
const labels={pending:'À synchroniser',info_received:'Étiquette créée',in_transit:'En transit',out_for_delivery:'En cours de livraison',delivered:'Livré par le transporteur · à vérifier',exception:'Incident transporteur',unknown:'Suivi non disponible'};
function norm(v){return String(v||'').trim().normalize('NFKC').toLocaleLowerCase('fr').replace(/\s+/g,' ');}
function createController({Orders=Order,Shipments=Shipment,tracker=tracking}={}){return {
 async page(req,res,next){try{
  const filter=['to_order','ordered','late','all'].includes(req.query.filter)?req.query.filter:'to_order';
  const orders=await Orders.find({status:{$in:ACTIVE},archived:{$ne:true},deletedAt:null}).select('number items sourcing purchase.supplier status orderType cloningStatus customerPromisedOn procurementContacts createdAt').sort({createdAt:-1}).lean();
  const groups=new Map();const allKeys=[];
  for(const order of orders){const summary=procurement.summarize(order);const signature=procurement.itemSignature(order.items);
   for(const line of summary.lines){if(!['unchecked','to_order','ordered'].includes(line.state))continue;
    if(filter==='to_order'&&line.state!=='to_order')continue;if(filter==='ordered'&&line.state!=='ordered')continue;if(filter==='late'&&!(line.state==='ordered'&&line.expectedOn&&line.expectedOn<procurement.today()))continue;
    const key=norm(line.supplier);if(!groups.has(key))groups.set(key,{supplier:line.supplier||'Fournisseur à renseigner',key,lines:[]});
    const lineKey=String(order._id)+':'+line.index+':'+signature;allKeys.push(lineKey);
    groups.get(key).lines.push({...line,orderId:String(order._id),orderNumber:order.number,signature,lineKey});
   }
  }
  const assigned=await Shipments.find({lineKeys:{$in:allKeys}}).select('lineKeys').lean();const assignedKeys=new Set(assigned.flatMap(s=>s.lineKeys));
  for(const group of groups.values())for(const line of group.lines)line.assigned=assignedKeys.has(line.lineKey);
  const page=Math.max(1,Math.min(10000,parseInt(req.query.page,10)||1));const count=await Shipments.countDocuments();
  const parcels=await Shipments.find().sort({createdAt:-1}).skip((page-1)*30).limit(30).lean();
  return res.render('admin/suppliers',{title:'Fournisseurs et colis entrants',groups:[...groups.values()],parcels:parcels.map(p=>({...p,id:String(p._id),label:labels[p.status],url:tracker.carrierUrl(p.carrier,p.trackingNumber)})),filter,trackingConfigured:tracker.configured(),parcelPage:page,parcelPages:Math.max(1,Math.ceil(count/30))});
 }catch(err){next(err);}},
 async create(req,res,next){try{
  if(!req.is('application/json'))return res.status(415).json({ok:false,error:'Format invalide.'});const b=req.body||{};
  const supplier=typeof b.supplier==='string'?b.supplier.trim():'';const number=typeof b.trackingNumber==='string'?b.trackingNumber.replace(/\s/g,'').toUpperCase():'';
  if(!supplier||supplier.length>160||!['dhl','fedex','ups'].includes(b.carrier)||!/^[-A-Za-z0-9]{5,100}$/.test(number)||!Array.isArray(b.links)||!b.links.length||b.links.length>100)return res.status(400).json({ok:false,error:'Renseignez le fournisseur, le transporteur, un numéro valide et les pièces du colis (100 lignes maximum).'});
  const links=[];const keys=new Set();
  for(const link of b.links){if(!link||!mongoose.isValidObjectId(link.orderId)||!Number.isInteger(link.itemIndex)||link.itemIndex<0)return res.status(400).json({ok:false,error:'Pièce invalide.'});
   const order=await Orders.findOne({_id:link.orderId,status:{$in:ACTIVE},archived:{$ne:true},deletedAt:null}).lean();
   if(!order||procurement.itemSignature(order.items)!==link.signature)return res.status(409).json({ok:false,error:'Une commande a changé. Actualisez la page avant de créer le colis.'});
   const line=procurement.linesFor(order)[link.itemIndex];
   if(!line||line.state!=='ordered'||norm(line.supplier)!==norm(supplier))return res.status(400).json({ok:false,error:'Chaque pièce doit être marquée commandée auprès de ce même fournisseur.'});
   const key=String(order._id)+':'+link.itemIndex+':'+link.signature;if(keys.has(key))return res.status(400).json({ok:false,error:'Pièce sélectionnée deux fois.'});keys.add(key);
   links.push({orderId:order._id,orderNumber:order.number,itemIndex:link.itemIndex,signature:link.signature,name:line.name,sku:line.sku,quantity:line.quantity});
  }
  const parcel=await Shipments.create({supplier,carrier:b.carrier,trackingNumber:number,links,lineKeys:[...keys],createdBy:req.session?.admin?.email||'Admin'});
  return res.status(201).json({ok:true,id:String(parcel._id)});
 }catch(err){if(err.code===11000)return res.status(409).json({ok:false,error:'Ce suivi ou une pièce sélectionnée est déjà associé à un colis. Consultez les colis enregistrés.'});next(err);}},
 async sync(req,res,next){try{if(!req.is('application/json'))return res.status(415).json({ok:false,error:'Format invalide.'});if(!mongoose.isValidObjectId(req.params.shipmentId))return res.status(400).json({ok:false,error:'Colis invalide.'});if(!await Shipments.exists({_id:req.params.shipmentId}))return res.status(404).json({ok:false,error:'Colis introuvable.'});const result=await tracker.syncOne(req.params.shipmentId);return res.json({ok:true,...result});}catch(err){next(err);}}
};}
module.exports={...createController(),createController};
