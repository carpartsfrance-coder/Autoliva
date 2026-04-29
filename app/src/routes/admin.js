/*
 * PERMISSIONS PAR ROUTE :
 * - /admin/parametres             → owner uniquement (team.manage)
 * - /admin/parametres/site        → owner uniquement (settings.site)
 * - /admin/parametres/facturation → owner uniquement (settings.billing)
 * - /admin/parametres/equipe      → owner uniquement (team.manage)
 * - /admin/expedition             → owner uniquement (settings.shipping)
 * - Toutes les autres routes      → tous les admins connectés (owner + employe)
 * - Dashboard KPI financiers      → masqués côté vue pour les employés
 */

const express = require('express');
const mongoose = require('mongoose');

const adminController = require('../controllers/adminController');
const savAdminController = require('../controllers/savAdminController');
const abandonedCartAdminController = require('../controllers/abandonedCartAdminController');
const orderEmailAdminController = require('../controllers/orderEmailAdminController');
const internalNoteAdminController = require('../controllers/internalNoteAdminController');
const blogAdminController = require('../controllers/blogAdminController');
const legalAdminController = require('../controllers/legalAdminController');
const analyticsController = require('../controllers/analyticsController');
const AdminUser = require('../models/AdminUser');
const Order = require('../models/Order');
const ReturnRequest = require('../models/ReturnRequest');
const SavTicket = require('../models/SavTicket');
const { handleProductImageUpload } = require('../middlewares/adminProductUpload');
const { handleBlogCoverUpload, handleBlogMediaUpload } = require('../middlewares/adminBlogUpload');
const { handleInvoiceLogoUpload } = require('../middlewares/adminInvoiceUpload');
const { handleShippingDocUpload } = require('../middlewares/adminShippingDocUpload');
const { handleHeroImageUpload } = require('../middlewares/adminHeroUpload');
const { hasAbility, isOwner } = require('../permissions');

const router = express.Router();

function getSafeReturnTo(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/admin')) return null;
  if (value.startsWith('//')) return null;
  return value;
}

async function requireAdminAuth(req, res, next) {
  try {
    if (req.session && req.session.admin) {
      const adminSession = req.session.admin;
      const adminUserId = adminSession && typeof adminSession.adminUserId === 'string' ? adminSession.adminUserId.trim() : '';
      const dbConnected = mongoose.connection.readyState === 1;

      if (dbConnected && adminUserId && mongoose.Types.ObjectId.isValid(adminUserId)) {
        const adminUser = await AdminUser.findById(adminUserId)
          .select('_id email firstName lastName role isActive')
          .lean();

        if (!adminUser || adminUser.isActive === false) {
          delete req.session.admin;
        } else {
          req.session.admin = {
            adminUserId: String(adminUser._id),
            email: adminUser.email,
            firstName: adminUser.firstName,
            lastName: adminUser.lastName,
            role: adminUser.role,
          };

          /* Injecte les helpers de permissions dans res.locals pour les vues */
          res.locals.hasAbility = (ability) => hasAbility(req.session.admin.role, ability);
          res.locals.isOwner = isOwner(req.session.admin.role);
          res.locals.adminRole = req.session.admin.role;

          return next();
        }
      } else {
        /* BDD non connectée ou pas d'adminUserId — mode fallback */
        const fallbackRole = adminSession.role || 'owner';
        res.locals.hasAbility = (ability) => hasAbility(fallbackRole, ability);
        res.locals.isOwner = isOwner(fallbackRole);
        res.locals.adminRole = fallbackRole;
        return next();
      }
    }

    const accept = req && req.headers && typeof req.headers.accept === 'string' ? req.headers.accept : '';
    if (accept.includes('application/json')) {
      return res.status(401).json({ ok: false, error: 'Session expirée. Veuillez vous reconnecter.', redirect: '/admin/connexion' });
    }
    const returnTo = getSafeReturnTo(req.originalUrl) || '/admin';
    return res.redirect(`/admin/connexion?returnTo=${encodeURIComponent(returnTo)}`);
  } catch (err) {
    return next(err);
  }
}

/**
 * Middleware factory : vérifie qu'un admin connecté possède l'ability requise.
 * À placer APRÈS requireAdminAuth.
 */
function requireAbility(ability) {
  return (req, res, next) => {
    const role = req.session.admin && req.session.admin.role;
    if (!role || !hasAbility(role, ability)) {
      return res.status(403).render('admin/forbidden', {
        admin: req.session.admin,
        pageTitle: 'Accès refusé',
      });
    }
    next();
  };
}

router.get('/connexion', adminController.getAdminLogin);
router.post('/connexion', adminController.postAdminLogin);
router.get('/connexion/2fa', adminController.getAdminLogin2fa);
router.post('/connexion/2fa', adminController.postAdminLogin2fa);
router.post('/deconnexion', adminController.postAdminLogout);

router.get('/reinitialiser', adminController.getAdminResetPassword);
router.post('/reinitialiser', adminController.postAdminResetPassword);

/* Sidebar global data — badge counts injected into every authenticated page */
router.use(async (req, res, next) => {
  if (req.session && req.session.admin) {
    try {
      const [pendingOrders, pendingReturns, savActionNeeded] = await Promise.all([
        Order.countDocuments({ status: 'pending_payment' }),
        ReturnRequest.countDocuments({ status: 'en_attente' }),
        SavTicket.countDocuments({ statut: { $nin: ['clos', 'refuse', 'resolu_garantie', 'resolu_facture', 'clos_sans_reponse'] } }),
      ]);
      res.locals.sidebarPendingCount = pendingOrders;
      res.locals.sidebarReturnsCount = pendingReturns;
      res.locals.sidebarSavCount = savActionNeeded;
    } catch (e) {
      res.locals.sidebarPendingCount = 0;
      res.locals.sidebarReturnsCount = 0;
      res.locals.sidebarSavCount = 0;
    }
  }
  next();
});

router.get('/', requireAdminAuth, adminController.getAdminDashboard);

router.get('/sav', requireAdminAuth, savAdminController.getSavDashboard);
router.get('/sav/tickets', requireAdminAuth, savAdminController.getSavTickets);
router.get('/sav/tickets/:numero', requireAdminAuth, savAdminController.getSavTicketDetail);
router.get('/parametres/sav', requireAdminAuth, savAdminController.getSavSettings);
router.get('/parametres/audit', requireAdminAuth, savAdminController.getAuditLog);
router.get('/parametres/integrations', requireAdminAuth, savAdminController.getIntegrations);
router.get('/sav/procedures', requireAdminAuth, savAdminController.getSavProcedures);
router.get('/sav/analytics', requireAdminAuth, savAdminController.getAnalytics);
router.get('/analytics/reputation', requireAdminAuth, savAdminController.getReputation);

// Profil - Sécurité (2FA)
router.get('/profil/securite', requireAdminAuth, adminController.getAdminProfileSecurity);
router.post('/profil/securite/2fa/setup', requireAdminAuth, adminController.postSetupTwoFactor);
router.post('/profil/securite/2fa/confirm', requireAdminAuth, adminController.postConfirmTwoFactor);
router.post('/profil/securite/2fa/disable', requireAdminAuth, adminController.postDisableTwoFactor);

router.get('/analytics', requireAdminAuth, analyticsController.getAnalyticsDashboard);
router.post('/analytics/synonyme', requireAdminAuth, analyticsController.postAddSynonym);

router.get('/commandes', requireAdminAuth, adminController.getAdminOrdersPage);
router.post('/commandes/supprimer-multi', requireAdminAuth, adminController.postAdminBulkDeleteOrders);
router.get('/commandes/nouvelle', requireAdminAuth, adminController.getAdminNewOrderPage);
router.get('/commandes/:orderId', requireAdminAuth, adminController.getAdminOrderDetailPage);
router.post('/commandes/:orderId/statut', requireAdminAuth, adminController.postAdminUpdateOrderStatus);
router.post('/commandes/:orderId/type', requireAdminAuth, adminController.postAdminUpdateOrderType);
router.post('/commandes/:orderId/consigne/recu', requireAdminAuth, adminController.postAdminMarkOrderConsigneReceived);
router.post('/commandes/:orderId/suivi', requireAdminAuth, handleShippingDocUpload, adminController.postAdminAddOrderShipment);
router.get('/commandes/:orderId/suivi/:shipmentId/document', requireAdminAuth, adminController.getAdminShipmentDocument);
router.post('/commandes/:orderId/suivi/:shipmentId/supprimer', requireAdminAuth, adminController.postAdminDeleteOrderShipment);
router.post('/commandes/:orderId/documents', requireAdminAuth, handleShippingDocUpload, adminController.postAdminUploadOrderDocument);
router.get('/commandes/:orderId/documents/:docId/view', requireAdminAuth, adminController.getAdminOrderDocument);
router.get('/commandes/:orderId/documents/:docId/download', requireAdminAuth, adminController.getAdminOrderDocumentDownload);
router.post('/commandes/:orderId/documents/:docId/supprimer', requireAdminAuth, adminController.postAdminDeleteOrderDocument);
router.post('/commandes/:orderId/supprimer', requireAdminAuth, adminController.postAdminDeleteOrder);
router.post('/commandes/:orderId/supprimer-definitivement', requireAdminAuth, adminController.postAdminHardDeleteOrder);
router.post('/commandes/:orderId/restaurer', requireAdminAuth, adminController.postAdminRestoreOrder);
router.post('/commandes/:orderId/archiver', requireAdminAuth, adminController.postAdminArchiveOrder);
router.post('/commandes/:orderId/desarchiver', requireAdminAuth, adminController.postAdminUnarchiveOrder);
router.post('/commandes/:orderId/scalapay/recapture', requireAdminAuth, adminController.postAdminRecaptureScalapayOrder);
router.post('/commandes/:orderId/retour', requireAdminAuth, adminController.postAdminCreateReturnFromOrder);
router.get('/commandes/:orderId/email/preview/:type', requireAdminAuth, orderEmailAdminController.getEmailPreview);
router.post('/commandes/:orderId/email/resend', requireAdminAuth, orderEmailAdminController.postResendEmail);

router.get('/catalogue', requireAdminAuth, adminController.getAdminCatalogPage);
router.get('/categories', requireAdminAuth, adminController.getAdminCategoriesPage);
router.post('/categories', requireAdminAuth, adminController.postAdminCreateCategory);
router.post('/categories/supprimer-multi', requireAdminAuth, adminController.postAdminBulkDeleteCategories);
router.post('/categories/:categoryId', requireAdminAuth, adminController.postAdminUpdateCategory);
router.post('/categories/:categoryId/toggle', requireAdminAuth, adminController.postAdminToggleCategory);
router.post('/categories/:categoryId/supprimer', requireAdminAuth, adminController.postAdminDeleteCategory);

/* SEO landings véhicule (/pieces-auto/:make[/:model[/:type]]) */
const adminVehicleLandingController = require('../controllers/adminVehicleLandingController');
router.get('/landings-vehicule', requireAdminAuth, requireAbility('settings.site'), adminVehicleLandingController.listLandings);
router.get('/landings-vehicule/:id', requireAdminAuth, requireAbility('settings.site'), adminVehicleLandingController.getLandingEdit);
router.post('/landings-vehicule', requireAdminAuth, requireAbility('settings.site'), adminVehicleLandingController.postLandingSave);
router.post('/landings-vehicule/:id/supprimer', requireAdminAuth, requireAbility('settings.site'), adminVehicleLandingController.postLandingDelete);

router.get('/vehicules', requireAdminAuth, adminController.getAdminVehicleMakesPage);
router.post('/vehicules', requireAdminAuth, adminController.postAdminCreateVehicleMake);
router.post('/vehicules/:makeId', requireAdminAuth, adminController.postAdminUpdateVehicleMake);
router.post('/vehicules/:makeId/supprimer', requireAdminAuth, adminController.postAdminDeleteVehicleMake);
router.post('/vehicules/:makeId/modeles', requireAdminAuth, adminController.postAdminAddVehicleModel);
router.post('/vehicules/:makeId/modeles/:modelId', requireAdminAuth, adminController.postAdminUpdateVehicleModel);
router.post('/vehicules/:makeId/modeles/:modelId/supprimer', requireAdminAuth, adminController.postAdminDeleteVehicleModel);

/* Expédition — owner uniquement */
router.get('/expedition', requireAdminAuth, requireAbility('settings.shipping'), adminController.getAdminShippingClassesPage);
router.post('/expedition', requireAdminAuth, requireAbility('settings.shipping'), adminController.postAdminCreateShippingClass);
router.post('/expedition/:classId', requireAdminAuth, requireAbility('settings.shipping'), adminController.postAdminUpdateShippingClass);
router.post('/expedition/:classId/supprimer', requireAdminAuth, requireAbility('settings.shipping'), adminController.postAdminDeleteShippingClass);

router.get('/catalogue/options', requireAdminAuth, adminController.getAdminProductOptionTemplatesPage);
router.post('/catalogue/options', requireAdminAuth, adminController.postAdminCreateProductOptionTemplate);
router.post('/catalogue/options/:templateId', requireAdminAuth, adminController.postAdminUpdateProductOptionTemplate);
router.post('/catalogue/options/:templateId/toggle', requireAdminAuth, adminController.postAdminToggleProductOptionTemplate);
router.post('/api/products/generate-draft', requireAdminAuth, adminController.postAdminGenerateProductDraft);
router.get('/api/products/generate-draft/:jobId', requireAdminAuth, adminController.getAdminGenerateProductDraftStatus);
router.post('/api/products/generate-draft/:jobId/cancel', requireAdminAuth, adminController.postAdminCancelProductDraft);
router.post('/api/products/generate-draft/cancel-all', requireAdminAuth, adminController.postAdminCancelAllProductDrafts);

router.get('/catalogue/nouveau', requireAdminAuth, adminController.getAdminNewProductPage);
router.post('/catalogue/nouveau', requireAdminAuth, handleProductImageUpload, adminController.postAdminCreateProduct);
router.post('/catalogue/generer-ia-multi', requireAdminAuth, adminController.postAdminBulkGenerateProductDrafts);
router.post('/catalogue/supprimer-multi', requireAdminAuth, adminController.postAdminBulkDeleteProducts);
router.get('/catalogue/:productId', requireAdminAuth, adminController.getAdminEditProductPage);
router.post('/catalogue/:productId', requireAdminAuth, handleProductImageUpload, adminController.postAdminUpdateProduct);
router.post('/catalogue/:productId/supprimer', requireAdminAuth, adminController.postAdminDeleteProduct);

const adminProductSearchHandler = typeof blogAdminController.getAdminProductSearchApi === 'function'
  ? blogAdminController.getAdminProductSearchApi
  : (req, res) => res.status(501).json({ ok: false, items: [], error: 'Recherche produits non disponible.' });
router.get('/api/products/search', requireAdminAuth, adminProductSearchHandler);
router.get('/api/produits/search', requireAdminAuth, adminProductSearchHandler);
const adminBlogSearchHandler = typeof blogAdminController.getAdminBlogPostSearchApi === 'function'
  ? blogAdminController.getAdminBlogPostSearchApi
  : (req, res) => res.status(501).json({ ok: false, items: [], error: 'Recherche blog non disponible.' });
router.get('/api/blog/search', requireAdminAuth, adminBlogSearchHandler);

router.get('/api/clients/search', requireAdminAuth, adminController.getAdminClientSearchApi);
router.post('/api/clients', requireAdminAuth, adminController.postAdminCreateClientApi);
router.post('/api/commandes/manuelle', requireAdminAuth, adminController.postAdminCreateManualOrder);
router.post('/api/commandes/:orderId/valider-brouillon', requireAdminAuth, adminController.postAdminValidateDraftOrder);
router.get('/api/commandes/:orderId/timeline', requireAdminAuth, adminController.getAdminOrderTimelineApi);
router.post('/api/commandes/:orderId/advance', requireAdminAuth, adminController.postAdminAdvanceOrder);
router.get('/api/alerts', requireAdminAuth, adminController.getAdminAlertsApi);

router.get('/clients', requireAdminAuth, adminController.getAdminClientsPage);
router.get('/clients/:userId', requireAdminAuth, adminController.getAdminClientDetailPage);
router.post('/clients/:userId/remise', requireAdminAuth, adminController.postAdminUpdateClientDiscount);

router.get('/activite-panier', requireAdminAuth, adminController.getAdminCartActivityPage);

router.get('/codes-promo', requireAdminAuth, adminController.getAdminPromoCodesPage);
router.post('/codes-promo', requireAdminAuth, adminController.postAdminCreatePromoCode);
router.post('/codes-promo/:promoId', requireAdminAuth, adminController.postAdminUpdatePromoCode);
router.post('/codes-promo/:promoId/supprimer', requireAdminAuth, adminController.postAdminDeletePromoCode);

router.get('/relances', requireAdminAuth, abandonedCartAdminController.getAdminAbandonedCartsPage);
router.get('/relances/:cartId', requireAdminAuth, abandonedCartAdminController.getAdminAbandonedCartDetail);
router.post('/relances/:cartId/relancer', requireAdminAuth, abandonedCartAdminController.postAdminManualReminder);

router.get('/retours', requireAdminAuth, adminController.getAdminReturnsPage);
router.get('/retours/:returnId', requireAdminAuth, adminController.getAdminReturnDetailPage);
router.post('/retours/:returnId/statut', requireAdminAuth, adminController.postAdminUpdateReturnStatus);
router.post('/retours/:returnId/note', requireAdminAuth, adminController.postAdminUpdateReturnNote);

router.get('/blog', requireAdminAuth, blogAdminController.getAdminBlogPostsPage);
router.get('/blog/nouveau', requireAdminAuth, blogAdminController.getAdminNewBlogPostPage);
router.post('/blog/nouveau', requireAdminAuth, handleBlogCoverUpload, blogAdminController.postAdminCreateBlogPost);
router.get('/blog/:postId', requireAdminAuth, blogAdminController.getAdminEditBlogPostPage);
router.post('/blog/:postId', requireAdminAuth, handleBlogCoverUpload, blogAdminController.postAdminUpdateBlogPost);
router.post('/blog/:postId/supprimer', requireAdminAuth, blogAdminController.postAdminDeleteBlogPost);

router.post('/api/blog/upload', requireAdminAuth, handleBlogMediaUpload, blogAdminController.postAdminBlogMediaUploadApi);

router.get('/pages-legales', requireAdminAuth, legalAdminController.getAdminLegalPages);
router.get('/pages-legales/:slug', requireAdminAuth, legalAdminController.getAdminEditLegalPage);
router.post('/pages-legales/:slug', requireAdminAuth, legalAdminController.postAdminUpdateLegalPage);

/* Paramètres — owner uniquement */
router.get('/parametres', requireAdminAuth, requireAbility('team.manage'), adminController.getAdminSettingsPage);
router.post('/parametres/equipe', requireAdminAuth, requireAbility('team.manage'), adminController.postAdminCreateBackofficeUser);
router.post('/parametres/equipe/:adminUserId/toggle', requireAdminAuth, requireAbility('team.manage'), adminController.postAdminToggleBackofficeUser);
router.post('/parametres/equipe/:adminUserId/mot-de-passe', requireAdminAuth, requireAbility('team.manage'), adminController.postAdminResetBackofficeUserPassword);
router.post('/parametres/mot-de-passe', requireAdminAuth, adminController.postAdminChangeOwnPassword);
router.get('/parametres/facturation', requireAdminAuth, requireAbility('settings.billing'), adminController.getAdminInvoiceSettingsPage);
router.post('/parametres/facturation', requireAdminAuth, requireAbility('settings.billing'), handleInvoiceLogoUpload, adminController.postAdminInvoiceSettings);
router.get('/parametres/site', requireAdminAuth, requireAbility('settings.site'), adminController.getAdminSiteSettingsPage);
router.post('/parametres/site', requireAdminAuth, requireAbility('settings.site'), adminController.postAdminSiteSettings);

router.get('/parametres/hero', requireAdminAuth, requireAbility('settings.site'), adminController.getAdminHeroSettingsPage);
router.post('/parametres/hero', requireAdminAuth, requireAbility('settings.site'), adminController.postAdminHeroSettings);
router.post('/parametres/hero/upload', requireAdminAuth, requireAbility('settings.site'), handleHeroImageUpload, adminController.postAdminHeroUploadImage);

router.get('/api/notes', requireAdminAuth, internalNoteAdminController.listNotes);
router.post('/api/notes', requireAdminAuth, internalNoteAdminController.createNote);
router.put('/api/notes/:id', requireAdminAuth, internalNoteAdminController.updateNote);
router.delete('/api/notes/:id', requireAdminAuth, internalNoteAdminController.deleteNote);
router.patch('/api/notes/:id/pin', requireAdminAuth, internalNoteAdminController.togglePin);
router.patch('/api/notes/:id/important', requireAdminAuth, internalNoteAdminController.toggleImportant);

module.exports = router;
