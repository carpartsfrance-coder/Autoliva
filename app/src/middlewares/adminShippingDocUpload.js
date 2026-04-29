const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter(req, file, cb) {
    if (!file || !file.mimetype) return cb(null, false);
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Fichier non supporté. Seuls les fichiers PDF sont acceptés.'));
    }
    return cb(null, true);
  },
});

function handleShippingDocUpload(req, res, next) {
  const single = upload.single('document');

  single(req, res, (err) => {
    if (err) {
      req.uploadError = err.message || "Erreur lors de l'upload.";
    }
    return next();
  });
}

module.exports = { handleShippingDocUpload };
