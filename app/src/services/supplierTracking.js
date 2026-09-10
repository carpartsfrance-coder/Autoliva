const Shipment=require('../models/SupplierShipment');
const track17=require('./track17');
function configured(){return !!String(process.env.TRACK17_API_KEY||'').trim() && !['0','false','off'].includes(String(process.env.TRACK17_ENABLED||'').toLowerCase());}
function normalizeStatus(code){return ({0:'delivered',2:'in_transit',4:'out_for_delivery',8:'info_received',20:'exception',30:'exception',35:'exception',50:'exception'})[code]||'unknown';}
function carrierUrl(carrier,number){const n=encodeURIComponent(number);return {ups:'https://www.ups.com/track?loc=fr_FR&tracknum='+n,dhl:'https://www.dhl.com/fr-fr/home/tracking.html?tracking-id='+n,fedex:'https://www.fedex.com/fedextrack/?trknbr='+n}[carrier]||'';}
async function syncOne(id,{Model=Shipment,lookup=(number)=>track17.getTrackingByNumber(process.env.TRACK17_API_KEY,number),enabled=configured(),now=new Date()}={}){
 if(!enabled)return {skipped:true,reason:'Suivi automatique non configuré (17TRACK).'};
 const parcel=await Model.findOneAndUpdate({_id:id,nextCheckAt:{$lte:now},$or:[{leaseUntil:null},{leaseUntil:{$lt:now}}]},{$set:{leaseUntil:new Date(now.getTime()+120000)}},{new:true}).lean();
 if(!parcel)return {skipped:true,reason:'Une vérification est déjà en cours ou vient d’être effectuée.'};
 const set={lastCheckedAt:now,nextCheckAt:new Date(now.getTime()+20*60000),leaseUntil:null};
 try{
  const info=await lookup(parcel.trackingNumber);
  if(!info){set.syncError='Suivi indisponible pour le moment. La réception n’est pas confirmée.';}
  else{
   const status=normalizeStatus(info.status_code);
   // A temporary provider failure must never undo a confirmed carrier delivery.
   set.status=parcel.status==='delivered'?'delivered':status;
   set.events=(info.events||[]).slice(0,30).map(e=>({event:String(e.event||'').slice(0,500),date:String(e.date||'').slice(0,100),location:String(e.location||'').slice(0,200)}));
   set.syncError=status==='unknown'?'Statut transporteur non reconnu ; aucune réception déduite.':'';
   if(status==='delivered'&&!parcel.deliveredAt)set.deliveredAt=now;
  }
 }catch(err){set.syncError='Transporteur indisponible ; une nouvelle vérification sera tentée.';}
 await Model.updateOne({_id:id,leaseUntil:parcel.leaseUntil},{$set:set});
 return {ok:true};
}
async function syncDue(){
 if(!configured())return {skipped:true};
 const rows=await Shipment.find({status:{$ne:'delivered'},nextCheckAt:{$lte:new Date()}}).sort({nextCheckAt:1}).limit(40).select('_id').lean();
 for(const row of rows)await syncOne(row._id);
 return {checked:rows.length};
}
module.exports={configured,normalizeStatus,carrierUrl,syncOne,syncDue};
