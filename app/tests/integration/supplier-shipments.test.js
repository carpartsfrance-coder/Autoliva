const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const mongoose=require('mongoose');const path=require('node:path');
const {MongoMemoryServer}=require('mongodb-memory-server');const Order=require('../../src/models/Order');const Shipment=require('../../src/models/SupplierShipment');const procurement=require('../../src/services/orderProcurement');const tracking=require('../../src/services/supplierTracking');const {createController}=require('../../src/controllers/supplierShipmentController');
test('colis partagé, suivi isolé, filtres par pièce et dédoublonnage',async()=>{
 const mongo=await MongoMemoryServer.create();let server;
 try{
  await mongoose.connect(mongo.getUri());await Shipment.init();
  const item=(sku,state)=>({name:'Pièce '+sku,sku,quantity:1,unitPriceCents:100,lineTotalCents:100,procurement:{state,supplier:'Fournisseur A',orderedOn:'2026-09-01',expectedOn:'2026-09-05'}});
  const a={_id:new mongoose.Types.ObjectId(),number:'SUP-A',status:'paid',items:[item('A','ordered'),item('B','to_order')],createdAt:new Date()};
  const b={_id:new mongoose.Types.ObjectId(),number:'SUP-B',status:'paid',items:[item('C','ordered')],createdAt:new Date()};
  const legacy={_id:new mongoose.Types.ObjectId(),number:'SUP-C',status:'paid',items:[{name:'Ancienne pièce',quantity:1}],sourcing:{status:'a_commander'}};
  await Order.collection.insertMany([a,b,legacy]);
  assert.equal(await Order.countDocuments(procurement.sourcingQuery('a_commander')),2);assert.equal(await Order.countDocuments(procurement.sourcingQuery('commandee')),2);assert.equal(await Order.countDocuments(procurement.sourcingQuery('overdue','2026-09-10')),2);
  assert.equal(procurement.linesFor(legacy)[0].state,'to_order');
  const app=express();app.use(express.json());app.set('view engine','ejs');app.set('views',path.resolve(__dirname,'../../src/views'));app.use((req,res,next)=>{res.locals.brand={NAME:'Démo'};res.locals.currentAdmin={firstName:'Test',lastName:'Local'};next();});
  const c=createController({tracker:{...tracking,configured:()=>false}});app.get('/suppliers',c.page);app.post('/parcel',c.create);app.use((err,req,res,next)=>res.status(500).json({ok:false,error:err.message}));
  await new Promise(resolve=>server=app.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const links=[a,b].map(o=>({orderId:String(o._id),itemIndex:0,signature:procurement.itemSignature(o.items)}));const body={supplier:'Fournisseur A',carrier:'ups',trackingNumber:'1ZTEST123456',links};
  const post=body=>fetch(base+'/parcel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const response=await post(body);assert.equal(response.status,201,await response.clone().text());const id=(await response.json()).id;
  assert.equal((await post(body)).status,409);assert.equal((await post({...body,trackingNumber:'OTHER123'})).status,409);
  assert.equal((await Shipment.findById(id).lean()).links.length,2);
  const now=new Date();await tracking.syncOne(id,{enabled:true,now,lookup:async()=>({status_code:4,events:[{event:'En cours de livraison'}]})});assert.equal((await Shipment.findById(id).lean()).status,'out_for_delivery');
  assert.equal((await Order.findById(a._id).lean()).status,'paid');assert.equal((await Order.findById(a._id).lean()).items[0].procurement.state,'ordered');
  const later=new Date(now.getTime()+21*60000);await tracking.syncOne(id,{enabled:true,now:later,lookup:async()=>({status_code:0,events:[]})});assert.equal((await Shipment.findById(id).lean()).status,'delivered');
  assert.equal(procurement.summarize(await Order.findById(b._id).lean()).ready,false,'livré transporteur ne valide pas les pièces');
  await tracking.syncOne(id,{enabled:true,now:new Date(later.getTime()+21*60000),lookup:async()=>{throw new Error('down');}});assert.equal((await Shipment.findById(id).lean()).status,'delivered');
  const rendered=await fetch(base+'/suppliers?filter=ordered');assert.equal(rendered.status,200);const html=await rendered.text();assert(html.includes('SUP-A'));assert(html.includes('SUP-B'));assert(html.includes('Livré par le transporteur'));assert(html.includes('non configuré'));
  assert.equal((await post({...body,trackingNumber:'X123456',links:[{...links[0],signature:'stale'}]})).status,409);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();await mongo.stop();}
});
