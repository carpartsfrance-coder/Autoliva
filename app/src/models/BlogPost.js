const mongoose = require('mongoose');

const blogPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },

    excerpt: { type: String, default: '', trim: true },
    contentHtml: { type: String, default: '', trim: true },
    contentMarkdown: { type: String, default: '', trim: true },

    coverImageUrl: { type: String, default: '', trim: true },

    category: {
      slug: { type: String, default: '', trim: true, lowercase: true },
      label: { type: String, default: '', trim: true },
    },

    authorName: { type: String, default: 'Expert CarParts', trim: true },

    readingTimeMinutes: { type: Number, default: 0, min: 0, max: 120 },

    relatedProductIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Product',
        },
      ],
      default: [],
    },

    isFeatured: { type: Boolean, default: false },
    isHomeFeatured: { type: Boolean, default: false },
    isPublished: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
    newsletterSentAt: { type: Date, default: null },

    seo: {
      primaryKeyword: { type: String, default: '', trim: true },
      metaTitle: { type: String, default: '', trim: true },
      metaDescription: { type: String, default: '', trim: true },
      metaRobots: { type: String, default: '', trim: true },
      ogImageUrl: { type: String, default: '', trim: true },
      canonicalPath: { type: String, default: '', trim: true },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('BlogPost', blogPostSchema);
