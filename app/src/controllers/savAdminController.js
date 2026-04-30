// Pages admin SAV — uniquement du rendu. Toute la logique passe par /admin/api/sav/*.

const brand = require('../config/brand');

function baseLocals(req, extra) {
  return Object.assign(
    {
      title: `SAV — Admin ${brand.NAME}`,
      isOwner: req.session && req.session.admin && req.session.admin.role === 'owner',
      currentAdmin: (req.session && req.session.admin) || null,
      // Le token Bearer pour les fetch côté navigateur — exposé seulement à un admin authentifié
      savApiToken: process.env.SAV_API_TOKEN || '',
    },
    extra || {}
  );
}

exports.getSavDashboard = (req, res) => {
  res.render('admin/sav-dashboard', baseLocals(req));
};

exports.getSavTickets = (req, res) => {
  res.render('admin/sav-tickets', baseLocals(req));
};

exports.getSavTicketDetail = (req, res) => {
  res.render(
    'admin/sav-ticket',
    baseLocals(req, { numero: req.params.numero })
  );
};

exports.getSavSettings = (req, res) => {
  res.render('admin/sav-settings', baseLocals(req, { title: 'Paramètres SAV — Admin' }));
};

exports.getAuditLog = (req, res) => {
  res.render('admin/audit-log', baseLocals(req, { title: 'Journal d\'audit — Admin' }));
};

exports.getAnalytics = (req, res) => {
  res.render('admin/sav-analytics', baseLocals(req, { title: 'Analytics SAV — Admin' }));
};

exports.getReputation = (req, res) => {
  res.render('admin/sav-reputation', baseLocals(req, { title: 'Réputation SAV — Admin' }));
};

exports.getSavProcedures = (req, res) => {
  res.render('admin/sav-procedures', baseLocals(req, { title: 'Procédures SAV — Admin' }));
};

exports.getIntegrations = (req, res) => {
  res.render('admin/sav-integrations', baseLocals(req, { title: 'Intégrations — Admin' }));
};
