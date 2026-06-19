const multer = require('multer');

const storage = multer.memoryStorage();

// Types acceptés : images + vidéos courtes (mp4/webm/mov)
const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime', // .mov (export iPhone)
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // 5 Mo par image
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;  // 50 Mo par vidéo
const MAX_DOC_BYTES = 20 * 1024 * 1024;    // 20 Mo par document technique (PDF)

const upload = multer({
  storage,
  limits: {
    // Limite globale = max vidéo (multer ne sait pas filtrer par type)
    fileSize: MAX_VIDEO_BYTES,
  },
  fileFilter(req, file, cb) {
    if (!file || !file.mimetype) return cb(null, false);
    const mt = file.mimetype.toLowerCase();
    // Champ "technicalDoc" : PDF uniquement (documents techniques produit).
    if (file.fieldname === 'technicalDoc') {
      if (mt === 'application/pdf') return cb(null, true);
      return cb(new Error('Document technique : PDF uniquement.'));
    }
    // Champ "image" (galerie) : images + vidéos courtes.
    if (mt.startsWith('image/')) return cb(null, true);
    if (ALLOWED_VIDEO_MIMES.has(mt)) return cb(null, true);
    return cb(new Error("Fichier non supporté. Merci d'envoyer une image (PNG, JPG, WEBP) ou une vidéo (MP4, WEBM, MOV)."));
  },
});

function handleProductImageUpload(req, res, next) {
  // .fields : galerie (image) + documents techniques (technicalDoc) en un seul POST.
  const multi = upload.fields([
    { name: 'image', maxCount: 10 },
    { name: 'technicalDoc', maxCount: 10 },
  ]);

  multi(req, res, (err) => {
    if (err) {
      req.uploadError = err.message || "Erreur lors de l'upload.";
      return next();
    }

    // .fields renvoie un objet { image: [...], technicalDoc: [...] }. On renormalise
    // req.files en TABLEAU d'images (le reste du contrôleur lit req.files ainsi,
    // inchangé) et on expose les PDF via req.technicalDocFiles.
    const grouped = (req.files && !Array.isArray(req.files)) ? req.files : {};
    const images = grouped.image || [];
    req.technicalDocFiles = grouped.technicalDoc || [];
    req.files = images;

    // Reject les images > 5 Mo (limite multer à 50 Mo pour autoriser les vidéos).
    for (const f of images) {
      if (f && f.mimetype && f.mimetype.startsWith('image/') && f.size > MAX_IMAGE_BYTES) {
        req.uploadError = `Image trop volumineuse : ${f.originalname} (${Math.round(f.size / 1024 / 1024)} Mo). Limite : 5 Mo par image.`;
        req.files = [];
        return next();
      }
    }
    // Reject les PDF > 20 Mo
    for (const f of req.technicalDocFiles) {
      if (f && f.size > MAX_DOC_BYTES) {
        req.uploadError = `Document trop volumineux : ${f.originalname} (${Math.round(f.size / 1024 / 1024)} Mo). Limite : 20 Mo par PDF.`;
        req.technicalDocFiles = [];
        return next();
      }
    }

    if (images.length > 0) req.file = images[0];

    return next();
  });
}

module.exports = {
  handleProductImageUpload,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_DOC_BYTES,
};
