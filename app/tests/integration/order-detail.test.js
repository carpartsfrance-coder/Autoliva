const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Order = require('../../src/models/Order');
const { getAdminOrderDetailPage } = require('../../src/controllers/adminController');
test('fiche réelle : pièces prioritaires, anciennes commandes et états spéciaux', async () => {
 const mongo = await MongoMemoryServer.create(); let server;
 try {
  await mongoose.connect(mongo.getUri());
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../../src/views'));
  app.use((req, res, next) => { req.session={}; res.locals.brand={NAME:'Test'}; res.locals.currentAdmin={firstName:'Test',lastName:'Local'}; res.locals.hasAbility=()=>true; next(); });
  app.get('/admin/commandes/:orderId', getAdminOrderDetailPage);
  app.use((err,req,res,next)=>res.status(500).send(err.stack));
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
  for(const status of ['paid','draft','label_created','shipped']) {
   const id=new mongoose.Types.ObjectId();
   await Order.collection.insertOne({_id:id,number:'DETAIL-'+status,status,createdAt:new Date(),items:[{name:'Pièce <test>',sku:'REF-1',quantity:1,unitPriceCents:100,lineTotalCents:100}],sourcing:{status:'a_commander'}});
   const response=await fetch('http://127.0.0.1:'+server.address().port+'/admin/commandes/'+id); const html=await response.text();
   assert.equal(response.status,200,html.slice(0,1600)); assert(html.includes('Pièce &lt;test&gt;')); assert(html.includes('À commander')); assert(!html.includes('data-sourcing-detail-status')); assert(html.includes('id="procurementDialog"'));
   assert(html.indexOf('id="detail-parts"')<html.indexOf('id="timeline-section"'));
   for(const section of ['detail-parts','detail-incoming','timeline-section','detail-shipping','detail-documents','detail-customer','detail-emails','detail-tax'])assert.equal(html.split('id="'+section+'"').length-1,1,section);
   if(status==='label_created')assert(html.includes('Marquer comme expédié (transporteur passé)'));
   if(status==='draft')assert(html.includes('validate-draft-btn'));
   if(status==='paid')assert(html.includes('data-open-refund-modal'));
  }
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();await mongo.stop();}
});
