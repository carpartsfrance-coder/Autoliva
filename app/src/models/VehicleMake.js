const mongoose = require('mongoose');

const VehicleMakeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true, trim: true, lowercase: true },
    models: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          nameLower: { type: String, required: true, trim: true, lowercase: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

VehicleMakeSchema.index({ nameLower: 1 }, { unique: true });
VehicleMakeSchema.index({ 'models.nameLower': 1 });

module.exports = mongoose.model('VehicleMake', VehicleMakeSchema);
