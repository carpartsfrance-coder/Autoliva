const mongoose = require('mongoose');

const returnStatusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['en_attente', 'accepte', 'refuse', 'en_transit', 'recu', 'rembourse', 'cloture'],
      required: true,
    },
    changedAt: { type: Date, required: true },
    changedBy: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const returnRequestSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    orderNumber: { type: String, required: true, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    accountType: { type: String, enum: ['particulier', 'pro'], required: true },
    reason: { type: String, default: '', trim: true },
    message: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['en_attente', 'accepte', 'refuse', 'en_transit', 'recu', 'rembourse', 'cloture'],
      default: 'en_attente',
      required: true,
    },
    statusHistory: { type: [returnStatusHistorySchema], default: [] },
    adminNote: { type: String, default: '', trim: true },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('ReturnRequest', returnRequestSchema);
