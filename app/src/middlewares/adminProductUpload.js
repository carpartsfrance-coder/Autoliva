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

const upload = multer({
  storage,
  limits: {
    // Limite globale = max vidéo (multer ne sait pas filtrer par type)
    fileSize: MAX_VIDEO_BYTES,
  },
  fileFilter(req, file, cb) {
    if (!file || !file.mimetype) return cb(null, false);
    const mt = file.mimetype.toLowerCase();
    if (mt.startsWith('image/')) return cb(null, true);
    if (ALLOWED_VIDEO_MIMES.has(mt)) return cb(null, true);
    return cb(new Error("Fichier non supporté. Merci d'envoyer une image (PNG, JPG, WEBP) ou une vidéo (MP4, WEBM, MOV)."));
  },
});

function handleProductImageUpload(req, res, next) {
  const multi = upload.array('image', 10);

  multi(req, res, (err) => {
    if (err) {
      req.uploadError = err.message || "Erreur lors de l'upload.";
      return next();
    }

    // Validation post-upload : reject les images > 5 Mo (la limite multer est à 50 Mo
    // pour autoriser les vidéos, mais on ne veut pas d'images énormes).
    if (Array.isArray(req.files)) {
      for (const f of req.files) {
        if (f && f.mimetype && f.mimetype.startsWith('image/') && f.size > MAX_IMAGE_BYTES) {
          req.uploadError = `Image trop volumineuse : ${f.originalname} (${Math.round(f.size / 1024 / 1024)} Mo). Limite : 5 Mo par image.`;
          req.files = [];
          return next();
        }
      }
    }

    if (Array.isArray(req.files) && req.files.length > 0) {
      req.file = req.files[0];
    }

    return next();
  });
}

module.exports = {
  handleProductImageUpload,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
};
