const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  supplier: {type:String,required:true,maxlength:160,trim:true},
  carrier: {type:String,enum:['dhl','fedex','ups'],required:true},
  trackingNumber: {type:String,required:true,maxlength:100},
  links: {type:[new mongoose.Schema({orderId:{type:mongoose.Schema.Types.ObjectId,ref:'Order',required:true},orderNumber:String,itemIndex:Number,signature:String,name:String,sku:String,quantity:Number},{_id:false})],required:true},
  // A whole order line belongs to at most one incoming parcel. This also makes retries safe.
  lineKeys:{type:[String],required:true},
  status:{type:String,enum:['pending','info_received','in_transit','out_for_delivery','delivered','exception','unknown'],default:'pending'},
  events:{type:[new mongoose.Schema({event:String,date:String,location:String},{_id:false})],default:[]},
  lastCheckedAt:Date, deliveredAt:Date, nextCheckAt:{type:Date,default:Date.now},
  leaseUntil:Date, syncError:{type:String,default:''}, createdBy:String,
},{timestamps:true});
schema.index({carrier:1,trackingNumber:1},{unique:true});
schema.index({lineKeys:1},{unique:true});
schema.index({nextCheckAt:1,leaseUntil:1});
module.exports=mongoose.model('SupplierShipment',schema);
