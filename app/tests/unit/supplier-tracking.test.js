const {test}=require('node:test');const assert=require('node:assert/strict');
const track=require('../../src/services/track17');const s=require('../../src/services/supplierTracking');
test('out for delivery et tentative échouée ne sont jamais une livraison',()=>{
 for(const event of ['Out for delivery','Delivery attempt failed','Not delivered','En cours de livraison','Tentative de livraison']){
  assert.notEqual(track.normalizeTrackToDelivery({e:30,z1:[{z:event}]}).status_code,0);
  assert.notEqual(track.normalizeTrackToDelivery({z1:[{z:event}]}).status_code,0);
 }
});
test('le statut courant prévaut sur un ancien événement livré',()=>{assert.equal(track.normalizeTrackToDelivery({e:20,z1:[{z:'Delivered'}]}).status_code,2);assert.equal(track.normalizeTrackToDelivery({e:40,z1:[]}).status_code,0);assert.equal(track.normalizeTrackToDelivery({e:0,z1:[]}).status_code,null);});
test('les statuts inconnus et liens des trois transporteurs restent explicites',()=>{assert.equal(s.normalizeStatus(null),'unknown');assert.equal(s.normalizeStatus(0),'delivered');for(const c of ['ups','fedex','dhl'])assert(s.carrierUrl(c,'TEST 123').startsWith('https://'));});
