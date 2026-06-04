const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'Autre', trim: true },
    brand: { type: String, default: '', trim: true },
    sku: { type: String, default: '', trim: true },
    // Code moteur principal (ex: CLHA). Les variantes/équivalences (CXXB…) vont
    // dans compatibleReferences. Indexé pour la recherche + SEO (schema.org mpn).
    engineCode: { type: String, default: '', trim: true, index: true },
    slug: { type: String, default: '', trim: true, lowercase: true },
    serviceType: {
      type: String,
      enum: ['', 'standalone_cloning'],
      default: '',
      trim: true,
    },
    priceCents: { type: Number, required: true, min: 0 },
    compareAtPriceCents: { type: Number, default: null, min: 0 },
    /* Prix d'achat fournisseur HT en centimes. Utilisé pour calculer
     * la marge brute dans le tableau de bord financier (/admin/finance).
     * Optionnel : null = inconnu, la marge sera affichée "—" pour les
     * commandes contenant ce produit. */
    costCents: { type: Number, default: null, min: 0 },
    consigne: {
      enabled: { type: Boolean, default: false },
      amountCents: { type: Number, default: 0, min: 0 },
      delayDays: { type: Number, default: 30, min: 0, max: 3650 },
      /* Si true : la consigne est ENCAISSÉE à la commande (caution, hors-TVA),
       * remboursée au retour du core. Si false (défaut) : modèle "sans caution"
       * actuel (facturée seulement en cas de non-retour). */
      chargeUpfront: { type: Boolean, default: false },
    },

    /* Pièces incluses / non incluses (surtout moteurs reconditionnés).
     * Optionnels et vides par défaut → aucun impact sur les produits
     * existants ; les blocs ne s'affichent que s'ils sont remplis. */
    inclusions: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },

    /* Garantie produit (mois + texte libre). Optionnelle. */
    warranty: {
      months: { type: Number, default: 0, min: 0 },
      text: { type: String, default: '', trim: true },
    },
    inStock: { type: Boolean, default: true },
    stockQty: { type: Number, default: null, min: 0 },
    /* isPublished : drapeau de publication SEO. true par défaut (compat avec
     * les produits déjà en base). Si false → exclu du sitemap public. Permet à
     * l'admin de masquer un brouillon / produit en cours d'édition sans le
     * supprimer. La page produit elle-même reste accessible (pour preview) ;
     * c'est seulement le sitemap qui filtre. */
    isPublished: { type: Boolean, default: true },
    imageUrl: { type: String, default: '' },

    shippingClassId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShippingClass', default: null },

    shippingDelayText: { type: String, default: '', trim: true },

    compatibleReferences: { type: [String], default: [] },

    searchSynonyms: { type: [String], default: [] },

    badges: {
      topLeft: { type: String, default: '', trim: true },
      condition: { type: String, default: '', trim: true },
    },

    galleryUrls: { type: [String], default: [] },
    // Type de chaque entrée galleryUrls (parallèle, même indice). Valeurs : 'image' | 'video'.
    // Vide ou undefined = 'image' par défaut (rétrocompat).
    galleryTypes: { type: [String], default: [] },

    shortDescription: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },

    keyPoints: { type: [String], default: [] },

    specs: {
      type: [
        {
          label: { type: String, default: '', trim: true },
          value: { type: String, default: '', trim: true },
        },
      ],
      default: [],
    },

    options: {
      type: [
        {
          templateId: { type: String, default: '', trim: true },
          key: { type: String, default: '', trim: true },
          label: { type: String, default: '', trim: true },
          type: { type: String, default: 'choice', trim: true },
          required: { type: Boolean, default: false },
          placeholder: { type: String, default: '', trim: true },
          helpText: { type: String, default: '', trim: true },
          priceDeltaCents: { type: Number, default: 0 },
          choices: {
            type: [
              {
                key: { type: String, default: '', trim: true },
                label: { type: String, default: '', trim: true },
                priceDeltaCents: { type: Number, default: 0 },
                absolutePriceCents: { type: Number, default: null, min: 0 },
                triggersCloning: { type: Boolean, default: false },
              },
            ],
            default: [],
          },
        },
      ],
      default: [],
    },

    optionTemplateIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'ProductOptionTemplate',
        },
      ],
      default: [],
    },

    reconditioningSteps: {
      type: [
        {
          title: { type: String, default: '', trim: true },
          description: { type: String, default: '', trim: true },
        },
      ],
      default: [],
    },

    compatibility: {
      type: [
        {
          make: { type: String, default: '', trim: true },
          model: { type: String, default: '', trim: true },
          years: { type: String, default: '', trim: true },
          engine: { type: String, default: '', trim: true },
        },
      ],
      default: [],
    },

    faqs: {
      type: [
        {
          question: { type: String, default: '', trim: true },
          answer: { type: String, default: '', trim: true },
        },
      ],
      default: [],
    },

    relatedBlogPostIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'BlogPost',
        },
      ],
      default: [],
    },

    media: {
      videoUrl: { type: String, default: '', trim: true },
    },

    seo: {
      metaTitle: { type: String, default: '', trim: true },
      metaDescription: { type: String, default: '', trim: true },
    },

    sections: {
      showKeyPoints: { type: Boolean, default: true },
      showSpecs: { type: Boolean, default: true },
      showReconditioning: { type: Boolean, default: true },
      showCompatibility: { type: Boolean, default: true },
      showFaq: { type: Boolean, default: true },
      showVideo: { type: Boolean, default: true },
      showSupportBox: { type: Boolean, default: true },
      showRelatedProducts: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Product', productSchema);
