const {test}=require('node:test');const assert=require('node:assert/strict');
const {MongoMemoryServer}=require('mongodb-memory-server');const mongoose=require('mongoose');const express=require('express');
const Order=require('../../src/models/Order');const {createController,payload}=require('../../src/controllers/orderProcurementController');
test('enregistrement réel isolé : lignes, contacts, validation et conflits',async()=>{
 const mongo=await MongoMemoryServer.create();let server;
 try{
  await mongoose.connect(mongo.getUri());
  const raw={_id:new mongoose.Types.ObjectId(),number:'TEST-1',status:'paid',items:[{name:'Pièce A',sku:'A',quantity:1,unitPriceCents:100,lineTotalCents:100},{name:'Pièce B',sku:'B',quantity:2,unitPriceCents:100,lineTotalCents:200}]};
  await Order.collection.insertOne(raw);
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.session={admin:{firstName:'Test',lastName:'Local'}};next();});const controller=createController();app.get('/:orderId',controller.get);app.post('/:orderId',controller.save);app.use((err,req,res,next)=>res.status(500).json({ok:false,error:err.message}));
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});const url='http://127.0.0.1:'+server.address().port+'/'+raw._id;
  let data=(await (await fetch(url)).json()).data;assert.equal(data.summary.next,'Vérifier le stock');
  const body={revision:data.revision,signature:data.signature,customerPromisedOn:'2026-10-01',lines:data.lines.map((line,i)=>({...line,state:i?'ordered':'in_stock',supplier:i?'Fournisseur B':'',orderedOn:i?'2026-09-01':'',expectedOn:i?'2026-09-14':''})),contact:{channel:'whatsapp',on:'2026-09-01',note:'Client informé'}};
  const post=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let response=await post(body);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));data=(await response.json()).data;assert.equal(data.revision,1);assert.equal(data.summary.available,1);assert.equal(data.contacts.length,1);assert.equal(data.lines[1].supplier,'Fournisseur B');
  assert.equal((await post(body)).status,409);assert.equal((await Order.findById(raw._id).lean()).procurementContacts.length,1);
  body.revision=1;body.lines[1].state='received';delete body.contact;response=await post(body);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));data=(await response.json()).data;assert.equal(data.summary.ready,true);
  body.revision=2;body.customerPromisedOn='2026-02-30';assert.equal((await post(body)).status,400);
  body.customerPromisedOn='';body.contact={channel:'phone',on:'2026-09-01',note:'Appel unique'};const concurrent=await Promise.all([post(body),post(body)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal((await Order.findById(raw._id).lean()).procurementContacts.length,2);body.revision=3;delete body.contact;await Order.collection.updateOne({_id:raw._id},{$set:{'items.0.quantity':3}});assert.equal((await post(body)).status,409);
  await Order.collection.updateOne({_id:raw._id},{$set:{status:'shipped'}});assert.equal((await post(body)).status,409);
  assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/invalid')).status,400);
 } finally {if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();await mongo.stop();}
});
