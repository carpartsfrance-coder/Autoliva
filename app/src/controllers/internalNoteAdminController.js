const mongoose = require('mongoose');

const InternalNote = require('../models/InternalNote');

function getAdminSession(req) {
  const admin = req.session && req.session.admin ? req.session.admin : null;
  if (!admin || !admin.adminUserId) return null;
  return {
    id: admin.adminUserId,
    email: admin.email || '',
    firstName: admin.firstName || '',
    lastName: admin.lastName || '',
    role: admin.role || '',
  };
}

function getAdminDisplayName(admin) {
  const first = (admin.firstName || '').trim();
  const last = (admin.lastName || '').trim();
  if (first || last) return `${first} ${last}`.trim();
  return admin.email || 'Admin';
}

function isOwnerOrAdmin(admin, note) {
  if (admin.role === 'owner') return true;
  return String(note.authorId) === String(admin.id);
}

/**
 * GET /admin/api/notes?entityType=order&entityId=xxx
 */
async function listNotes(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });

    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType.trim() : '';
    const entityId = typeof req.query.entityId === 'string' ? req.query.entityId.trim() : '';

    if (!['order', 'client'].includes(entityType)) {
      return res.status(400).json({ ok: false, error: 'entityType invalide (order ou client).' });
    }
    if (!entityId || !mongoose.Types.ObjectId.isValid(entityId)) {
      return res.status(400).json({ ok: false, error: 'entityId invalide.' });
    }

    const notes = await InternalNote.find({ entityType, entityId: new mongoose.Types.ObjectId(entityId) })
      .sort({ isPinned: -1, createdAt: -1 })
      .limit(200)
      .lean();

    const admin = getAdminSession(req);

    return res.json({
      ok: true,
      notes: notes.map((n) => ({
        id: String(n._id),
        content: n.content,
        authorName: n.authorName || '',
        authorId: String(n.authorId),
        isPinned: !!n.isPinned,
        isImportant: !!n.isImportant,
        createdAt: n.createdAt ? n.createdAt.toISOString() : '',
        updatedAt: n.updatedAt ? n.updatedAt.toISOString() : '',
        canEdit: admin ? isOwnerOrAdmin(admin, n) : false,
      })),
    });
  } catch (err) {
    console.error('[notes] Erreur listNotes:', err.message || err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
}

/**
 * POST /admin/api/notes
 * Body: { entityType, entityId, content, isPinned?, isImportant? }
 */
async function createNote(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });

    const admin = getAdminSession(req);
    if (!admin) return res.status(401).json({ ok: false, error: 'Non authentifié.' });

    const entityType = typeof req.body.entityType === 'string' ? req.body.entityType.trim() : '';
    const entityId = typeof req.body.entityId === 'string' ? req.body.entityId.trim() : '';
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    const isPinned = req.body.isPinned === true || req.body.isPinned === 'true';
    const isImportant = req.body.isImportant === true || req.body.isImportant === 'true';

    if (!['order', 'client'].includes(entityType)) {
      return res.status(400).json({ ok: false, error: 'entityType invalide.' });
    }
    if (!entityId || !mongoose.Types.ObjectId.isValid(entityId)) {
      return res.status(400).json({ ok: false, error: 'entityId invalide.' });
    }
    if (!content) {
      return res.status(400).json({ ok: false, error: 'Le contenu de la note est requis.' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ ok: false, error: 'La note ne peut pas dépasser 2000 caractères.' });
    }

    const note = await InternalNote.create({
      entityType,
      entityId: new mongoose.Types.ObjectId(entityId),
      content,
      authorId: new mongoose.Types.ObjectId(admin.id),
      authorName: getAdminDisplayName(admin),
      isPinned,
      isImportant,
    });

    return res.status(201).json({
      ok: true,
      note: {
        id: String(note._id),
        content: note.content,
        authorName: note.authorName,
        authorId: String(note.authorId),
        isPinned: note.isPinned,
        isImportant: note.isImportant,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString(),
        canEdit: true,
      },
    });
  } catch (err) {
    console.error('[notes] Erreur createNote:', err.message || err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
}

/**
 * PUT /admin/api/notes/:id
 * Body: { content, isPinned?, isImportant? }
 */
async function updateNote(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });

    const admin = getAdminSession(req);
    if (!admin) return res.status(401).json({ ok: false, error: 'Non authentifié.' });

    const noteId = req.params.id;
    if (!noteId || !mongoose.Types.ObjectId.isValid(noteId)) {
      return res.status(400).json({ ok: false, error: 'ID note invalide.' });
    }

    const note = await InternalNote.findById(noteId);
    if (!note) return res.status(404).json({ ok: false, error: 'Note introuvable.' });

    if (!isOwnerOrAdmin(admin, note)) {
      return res.status(403).json({ ok: false, error: 'Vous ne pouvez modifier que vos propres notes.' });
    }

    const content = typeof req.body.content === 'string' ? req.body.content.trim() : undefined;
    if (content !== undefined) {
      if (!content) return res.status(400).json({ ok: false, error: 'Le contenu ne peut pas être vide.' });
      if (content.length > 2000) return res.status(400).json({ ok: false, error: 'Max 2000 caractères.' });
      note.content = content;
    }

    if (req.body.isPinned !== undefined) {
      note.isPinned = req.body.isPinned === true || req.body.isPinned === 'true';
    }
    if (req.body.isImportant !== undefined) {
      note.isImportant = req.body.isImportant === true || req.body.isImportant === 'true';
    }

    await note.save();

    return res.json({
      ok: true,
      note: {
        id: String(note._id),
        content: note.content,
        authorName: note.authorName,
        authorId: String(note.authorId),
        isPinned: note.isPinned,
        isImportant: note.isImportant,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString(),
        canEdit: true,
      },
    });
  } catch (err) {
    console.error('[notes] Erreur updateNote:', err.message || err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
}

/**
 * DELETE /admin/api/notes/:id
 */
async function deleteNote(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });

    const admin = getAdminSession(req);
    if (!admin) return res.status(401).json({ ok: false, error: 'Non authentifié.' });

    const noteId = req.params.id;
    if (!noteId || !mongoose.Types.ObjectId.isValid(noteId)) {
      return res.status(400).json({ ok: false, error: 'ID note invalide.' });
    }

    const note = await InternalNote.findById(noteId).lean();
    if (!note) return res.status(404).json({ ok: false, error: 'Note introuvable.' });

    if (!isOwnerOrAdmin(admin, note)) {
      return res.status(403).json({ ok: false, error: 'Vous ne pouvez supprimer que vos propres notes.' });
    }

    await InternalNote.deleteOne({ _id: noteId });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[notes] Erreur deleteNote:', err.message || err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
}

/**
 * PATCH /admin/api/notes/:id/pin
 */
async function togglePin(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });

    const admin = getAdminSession(req);
    if (!admin) return res.status(401).json({ ok: false, error: 'Non authentifié.' });

    const noteId = req.params.id;
    if (!noteId || !mongoose.Types.ObjectId.isValid(noteId)) {
      return res.status(400).json({ ok: false, error: 'ID note invalide.' });
    }

    const note = await InternalNote.findById(noteId);
    if (!note) return res.status(404).json({ ok: false, error: 'Note introuvable.' });

    if (!isOwnerOrAdmin(admin, note)) {
      return res.status(403).json({ ok: false, error: 'Accès refusé.' });
    }

    note.isPinned = !note.isPinned;
    await note.save();

    return res.json({ ok: true, isPinned: note.isPinned });
  } catch (err) {
    console.error('[notes] Erreur togglePin:', err.message || err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
}

/**
 * PATCH /admin/api/notes/:id/important
 */
async function toggleImportant(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });

    const admin = getAdminSession(req);
    if (!admin) return res.status(401).json({ ok: false, error: 'Non authentifié.' });

    const noteId = req.params.id;
    if (!noteId || !mongoose.Types.ObjectId.isValid(noteId)) {
      return res.status(400).json({ ok: false, error: 'ID note invalide.' });
    }

    const note = await InternalNote.findById(noteId);
    if (!note) return res.status(404).json({ ok: false, error: 'Note introuvable.' });

    if (!isOwnerOrAdmin(admin, note)) {
      return res.status(403).json({ ok: false, error: 'Accès refusé.' });
    }

    note.isImportant = !note.isImportant;
    await note.save();

    return res.json({ ok: true, isImportant: note.isImportant });
  } catch (err) {
    console.error('[notes] Erreur toggleImportant:', err.message || err);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
}

module.exports = {
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  togglePin,
  toggleImportant,
};
