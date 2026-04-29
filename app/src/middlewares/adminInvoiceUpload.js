const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 3 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    if (!file || !file.mimetype) return cb(null, false);
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error("Fichier non supporté. Merci d'envoyer une image."));
    }
    return cb(null, true);
  },
});

function handleInvoiceLogoUpload(req, res, next) {
  const single = upload.single('logoFile');

  single(req, res, (err) => {
    if (err) {
      req.uploadError = err.message || "Erreur lors de l'upload.";
      return next();
    }

    return next();
  });
}

module.exports = {
  handleInvoiceLogoUpload,
};
