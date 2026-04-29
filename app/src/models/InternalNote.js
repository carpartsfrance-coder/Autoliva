const mongoose = require('mongoose');

const internalNoteSchema = new mongoose.Schema(
  {
    entityType: {
      type: String,
      enum: ['order', 'client'],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    authorName: {
      type: String,
      default: '',
      trim: true,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    isImportant: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

internalNoteSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

module.exports = mongoose.model('InternalNote', internalNoteSchema);
