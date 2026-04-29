const mongoose = require('mongoose');

const {
  listLegalPages,
  getLegalPageBySlug,
  updateLegalPageBySlug,
} = require('../services/legalPages');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseIntOrZero(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

async function getAdminLegalPages(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    const errorMessage = req.session.adminLegalError || null;
    const successMessage = req.session.adminLegalSuccess || null;
    delete req.session.adminLegalError;
    delete req.session.adminLegalSuccess;

    const pages = await listLegalPages({ dbConnected, includeUnpublished: true });

    return res.render('admin/legal-pages', {
      title: 'Admin - Pages légales',
      dbConnected,
      errorMessage,
      successMessage,
      pages,
    });
  } catch (err) {
    return next(err);
  }
}

async function getAdminEditLegalPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const slug = req.params && req.params.slug ? String(req.params.slug) : '';

    const errorMessage = req.session.adminLegalError || null;
    const successMessage = req.session.adminLegalSuccess || null;
    delete req.session.adminLegalError;
    delete req.session.adminLegalSuccess;

    const page = await getLegalPageBySlug({ slug, dbConnected, includeUnpublished: true });
    if (!page) {
      req.session.adminLegalError = 'Page introuvable.';
      return res.redirect('/admin/pages-legales');
    }

    return res.render('admin/legal-page', {
      title: `Admin - ${page.title}`,
      dbConnected,
      errorMessage,
      successMessage,
      page,
      form: {
        title: page.title,
        content: page.content || '',
        isPublished: page.isPublished !== false,
        sortOrder: Number.isFinite(page.sortOrder) ? page.sortOrder : 0,
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function postAdminUpdateLegalPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const slug = req.params && req.params.slug ? String(req.params.slug) : '';

    if (!dbConnected) {
      req.session.adminLegalError = "La base de données n'est pas disponible. Impossible d'enregistrer.";
      return res.redirect(`/admin/pages-legales/${encodeURIComponent(slug)}`);
    }

    const title = getTrimmedString(req.body.title);
    const content = typeof req.body.content === 'string' ? req.body.content : '';
    const isPublished = req.body.isPublished === 'on' || req.body.isPublished === 'true' || req.body.isPublished === true;
    const sortOrder = parseIntOrZero(req.body.sortOrder);

    if (!title) {
      req.session.adminLegalError = 'Merci de renseigner un titre.';
      return res.redirect(`/admin/pages-legales/${encodeURIComponent(slug)}`);
    }

    const result = await updateLegalPageBySlug({ slug, title, content, isPublished, sortOrder, dbConnected });
    if (!result.ok) {
      req.session.adminLegalError = "Impossible d'enregistrer pour le moment.";
      return res.redirect(`/admin/pages-legales/${encodeURIComponent(slug)}`);
    }

    req.session.adminLegalSuccess = 'Page enregistrée.';
    return res.redirect(`/admin/pages-legales/${encodeURIComponent(slug)}`);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAdminLegalPages,
  getAdminEditLegalPage,
  postAdminUpdateLegalPage,
};
