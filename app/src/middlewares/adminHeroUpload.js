const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 8 * 1024 * 1024, // 8 MB — hero images sont souvent plus grandes que blog covers
  },
  fileFilter(req, file, cb) {
    if (!file || !file.mimetype) return cb(null, false);
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error("Fichier non supporté. Merci d'envoyer une image (PNG, JPG, JPEG, WEBP)."));
    }
    return cb(null, true);
  },
});

function handleHeroImageUpload(req, res, next) {
  const single = upload.single('image');

  single(req, res, (err) => {
    if (err) {
      req.uploadError = err.message || "Erreur lors de l'upload de l'image hero.";
      return next();
    }
    return next();
  });
}

module.exports = {
  handleHeroImageUpload,
};
