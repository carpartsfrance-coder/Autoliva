/*
 * /comptable/* — espace dédié au cabinet comptable (rôle `comptable`).
 *
 * Caractéristiques :
 *  - lecture seule (aucune écriture sur les commandes, produits, clients…)
 *  - layout épuré dédié (sidebar minimale, branding "Compta")
 *  - 100% mutualisé avec le back-office : même AdminUser, même login,
 *    même PDF, mêmes données (Order.invoice / Order.creditNotes / Order.refunds)
 *  - chaque téléchargement est tracé dans AuditLog (conformité RGPD)
 *
 * Rôles autorisés : `comptable` ET `owner` (l'owner doit pouvoir tester /
 * consulter l'espace que voit son comptable).
 */

const express = require('express');
const mongoose = require('mongoose');

const AdminUser = require('../models/AdminUser');
const comptableController = require('../controllers/comptableController');
const { hasAbility, isOwner, isComptable, ROLES } = require('../permissions');

const router = express.Router();

function getSafeReturnTo(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('//')) return null;
  if (!value.startsWith('/comptable')) return null;
  return value;
}

/**
 * Auth middleware spécifique à /comptable :
 *  - exige une session admin valide
 *  - accepte les rôles `comptable` et `owner`
 *  - refuse les `employe` (qui n'ont rien à faire ici)
 */
async function requireComptableAuth(req, res, next) {
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
        } else if (!isOwner(adminUser.role) && !isComptable(adminUser.role)) {
          /* Employé connecté qui tente /comptable : on le renvoie sur /admin
           * pour qu'il continue son travail normal. */
          return res.redirect('/admin');
        } else {
          req.session.admin = {
            adminUserId: String(adminUser._id),
            email: adminUser.email,
            firstName: adminUser.firstName,
            lastName: adminUser.lastName,
            role: adminUser.role,
          };

          res.locals.hasAbility = (ability) => hasAbility(req.session.admin.role, ability);
          res.locals.isOwner = isOwner(req.session.admin.role);
          res.locals.isComptable = isComptable(req.session.admin.role);
          res.locals.adminRole = req.session.admin.role;
          res.locals.currentUser = req.session.admin;

          return next();
        }
      }
    }

    const accept = req && req.headers && typeof req.headers.accept === 'string' ? req.headers.accept : '';
    if (accept.includes('application/json')) {
      return res.status(401).json({ ok: false, error: 'Session expirée. Veuillez vous reconnecter.', redirect: '/admin/connexion' });
    }
    const returnTo = getSafeReturnTo(req.originalUrl) || '/comptable';
    return res.redirect(`/admin/connexion?returnTo=${encodeURIComponent(returnTo)}`);
  } catch (err) {
    return next(err);
  }
}

/**
 * Vérifie qu'un comptable connecté a bien l'ability demandée.
 * Le owner passe toujours (wildcard '*').
 */
function requireAbility(ability) {
  return (req, res, next) => {
    const role = req.session.admin && req.session.admin.role;
    if (!role || !hasAbility(role, ability)) {
      return res.status(403).render('comptable/forbidden', {
        currentUser: req.session.admin,
        pageTitle: 'Accès refusé',
      });
    }
    next();
  };
}

/* ── Dashboard ────────────────────────────────────────────────── */
router.get('/', requireComptableAuth, requireAbility('accounting.view'), comptableController.getDashboard);

/* ── Factures ─────────────────────────────────────────────────── */
router.get('/factures', requireComptableAuth, requireAbility('accounting.invoices.read'), comptableController.getInvoicesList);
router.get('/factures/:orderId/pdf', requireComptableAuth, requireAbility('accounting.invoices.read'), comptableController.getInvoicePdf);

/* ── Avoirs ───────────────────────────────────────────────────── */
router.get('/avoirs', requireComptableAuth, requireAbility('accounting.creditNotes.read'), comptableController.getCreditNotesList);
router.get('/avoirs/:orderId/:creditNoteNumber/pdf', requireComptableAuth, requireAbility('accounting.creditNotes.read'), comptableController.getCreditNotePdf);

/* ── Remboursements ───────────────────────────────────────────── */
router.get('/remboursements', requireComptableAuth, requireAbility('accounting.refunds.read'), comptableController.getRefundsList);

/* ── Exports CSV + ZIP ────────────────────────────────────────── */
router.get('/export/:year/:month/csv', requireComptableAuth, requireAbility('accounting.export'), comptableController.getMonthlyCsvExport);
router.get('/export/:year/:month/pdfs.zip', requireComptableAuth, requireAbility('accounting.export'), comptableController.getMonthlyPdfZipExport);

/* ── Déconnexion ──────────────────────────────────────────────── */
router.post('/deconnexion', requireComptableAuth, comptableController.postLogout);

module.exports = router;
