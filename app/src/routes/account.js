const express = require('express');
const multer = require('multer');

const accountController = require('../controllers/accountController');
const accountSavController = require('../controllers/accountSavController');

const router = express.Router();

// Multer pour pièces jointes côté client (5 fichiers, 10 Mo)
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const clientUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.indexOf(file.mimetype) === -1) {
      return cb(new Error('Format non autorisé'));
    }
    cb(null, true);
  },
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();

  const returnTo = req.originalUrl;
  return res.redirect(`/compte/connexion?returnTo=${encodeURIComponent(returnTo)}`);
}

router.get('/', requireAuth, accountController.getAccount);
router.post('/type', accountController.setAccountType);

router.get('/connexion', accountController.getLogin);
router.post('/connexion', accountController.postLogin);

router.get('/inscription', accountController.getRegister);
router.post('/inscription', accountController.postRegister);

router.get('/mot-de-passe-oublie', accountController.getForgotPassword);
router.post('/mot-de-passe-oublie', accountController.postForgotPassword);
router.get('/reinitialiser-mot-de-passe', accountController.getResetPassword);
router.post('/reinitialiser-mot-de-passe', accountController.postResetPassword);

router.post('/deconnexion', accountController.postLogout);

router.get('/profil', requireAuth, accountController.getProfile);
router.post('/profil', requireAuth, accountController.postProfile);

router.get('/securite', requireAuth, accountController.getSecurity);
router.post('/securite', requireAuth, accountController.postSecurity);

router.get('/adresses', requireAuth, accountController.getAddresses);
router.post('/adresses', requireAuth, accountController.postAddAddress);
router.post('/adresses/:addressId/par-defaut', requireAuth, accountController.postSetDefaultAddress);
router.post('/adresses/:addressId/supprimer', requireAuth, accountController.postDeleteAddress);

router.get('/commandes', requireAuth, accountController.getOrdersPage);
router.get('/commandes/:orderId', requireAuth, accountController.getOrderDetailPage);
router.get('/commandes/:orderId/suivi', requireAuth, accountController.getOrderTrackingPage);
router.get('/commandes/:orderId/facture.pdf', requireAuth, accountController.getOrderInvoicePdf);
router.get('/commandes/:orderId/documents/:docId', requireAuth, accountController.getOrderDocumentForClient);
router.get('/commandes/:orderId/shipment-doc/:shipmentId', requireAuth, accountController.getOrderShipmentDocForClient);
router.post('/commandes/:orderId/racheter', requireAuth, accountController.postRepurchaseOrder);
router.get('/factures', requireAuth, accountController.getInvoicesPage);
router.get('/garage', requireAuth, accountController.getGaragePage);

// SAV — espace client
router.get('/sav', requireAuth, accountSavController.getSavList);
router.get('/sav/:numero', requireAuth, accountSavController.getSavDetail);
router.post(
  '/sav/:numero/messages',
  requireAuth,
  (req, res, next) => clientUpload.array('attachments', 5)(req, res, (err) => {
    if (err) return res.redirect(`/compte/sav/${encodeURIComponent(req.params.numero)}?error=upload`);
    next();
  }),
  accountSavController.postSavMessage,
);

// RGPD
router.get('/rgpd', requireAuth, accountSavController.getRgpdPage);
router.get('/rgpd/export.json', requireAuth, accountSavController.getRgpdExport);
router.post('/rgpd/supprimer-sav', requireAuth, accountSavController.postRgpdDeleteSav);

module.exports = router;
