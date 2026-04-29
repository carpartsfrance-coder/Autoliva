const express = require('express');
const multer = require('multer');

const aboutController = require('../controllers/aboutController');
const homeController = require('../controllers/homeController');
const savController = require('../controllers/savController');
const productController = require('../controllers/productController');
const contactController = require('../controllers/contactController');
const legacyRedirectController = require('../controllers/legacyRedirectController');
const { getSiteUrlFromReq } = require('../services/siteUrl');
const brand = require('../config/brand');

const router = express.Router();

router.get('/', homeController.getHome);
router.get('/shop', legacyRedirectController.redirectLegacyShop);
router.get('/product', (req, res) => res.redirect(301, '/produits'));
router.get('/product/:slug', productController.getProductBySlug);

router.get('/contact', contactController.getContactPage);
router.post('/contact', contactController.postContact);
router.get('/devis', (req, res, next) => {
  req.query = { ...(req.query || {}), type: 'devis' };
  return contactController.getContactPage(req, res, next);
});
router.post('/devis', (req, res, next) => {
  req.body = { ...(req.body || {}), mode: 'devis', subject: 'devis' };
  return contactController.postContact(req, res, next);
});

router.get('/notre-histoire', aboutController.getAboutPage);

// Entrée principale : sélection du motif SAV
router.get('/sav', savController.getMotifSelect);
// Ancien wizard (pièce défectueuse 6 étapes) — accessible via motif=piece_defectueuse
router.get('/sav/piece-defectueuse', savController.getSavHome);
// Formulaire court pour les 9 autres motifs
router.get('/sav/demande/:motif', savController.getSimpleForm);
const simpleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    var ok = ['image/jpeg','image/png','image/webp','application/pdf'].indexOf(file.mimetype) >= 0;
    cb(ok ? null : new Error('Format non autorisé'), ok);
  },
});
router.post('/sav/demande',
  (req, res, next) => simpleUpload.array('attachments', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: 'Upload refusé : ' + err.message });
    next();
  }),
  savController.postSimpleForm);
router.get('/sav/notre-engagement', (req, res) => {
  res.render('sav-engagement', {
    title: `Notre engagement SAV — ${brand.NAME}`,
    metaDescription: 'Transparence, banc dédié, réponse sous 5 jours, équité. Découvrez notre engagement Service Après-Vente.',
    canonicalUrl: `${getSiteUrlFromReq(req)}/sav/notre-engagement`,
  });
});
router.get('/legal/cgv-sav', (req, res) => {
  res.render('legal/cgv-sav', {
    title: `CGV SAV — ${brand.NAME}`,
    metaDescription: `Conditions générales du Service Après-Vente ${brand.NAME}.`,
    canonicalUrl: `${getSiteUrlFromReq(req)}/legal/cgv-sav`,
  });
});
router.post('/sav/check-commande', savController.postCheckCommande);

// Suivi invité
const savGuestController = require('../controllers/savGuestController');
const guestUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    var ok = ['image/jpeg','image/png','image/webp','application/pdf'].indexOf(file.mimetype) >= 0;
    cb(ok ? null : new Error('Format non autorisé'), ok);
  },
});
router.get('/sav/suivi', savGuestController.getSuiviForm);
router.post('/sav/suivi', savGuestController.postSuiviForm);
router.get('/sav/suivi/:numero', savGuestController.getSuiviDetail);
router.post(
  '/sav/suivi/:numero/messages',
  (req, res, next) => guestUpload.array('attachments', 5)(req, res, (err) => {
    if (err) return res.redirect(`/sav/suivi/${encodeURIComponent(req.params.numero)}?error=upload`);
    next();
  }),
  savGuestController.postSuiviMessage,
);
router.get('/sav/confirmation/:numero', savController.getConfirmation);
router.get('/sav/feedback/:numero', savController.getFeedback);
router.post('/sav/feedback/:numero', savController.postFeedback);

router.get('/faq', (req, res) => {
  const { getFaqItems } = require('../services/faqContent');
  const baseUrl = getSiteUrlFromReq(req);
  const canonicalUrl = `${baseUrl}/faq`;
  const faqItems = getFaqItems({ phone: brand.PHONE, phoneIntl: brand.PHONE_INTL });

  /* FAQPage JSON-LD : éligible aux rich results FAQ dans les SERPs Google.
     mainEntity = liste de Question avec acceptedAnswer.text. On utilise le
     champ answerPlain (sans HTML) pour éviter que Google rejette le markup. */
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        url: canonicalUrl,
        mainEntity: faqItems.map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: item.answerPlain,
          },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Accueil', item: baseUrl ? `${baseUrl}/` : '/' },
          { '@type': 'ListItem', position: 2, name: 'FAQ', item: canonicalUrl },
        ],
      },
    ],
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const title = `FAQ - Questions fréquentes | ${brand.NAME}`;
  const metaDescription = 'Retrouvez les réponses aux questions les plus fréquentes : livraison, échange standard, garantie, compatibilité, paiement et retours.';

  res.render('faq/index', {
    title,
    metaDescription,
    canonicalUrl,
    ogTitle: title,
    ogDescription: metaDescription,
    ogUrl: canonicalUrl,
    ogType: 'website',
    ogSiteName: brand.NAME,
    jsonLd,
    faqItems,
  });
});

router.get('/:slug', homeController.redirectLegacyBlogSlug);

module.exports = router;
