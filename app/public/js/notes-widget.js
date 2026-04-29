/**
 * Notes Internes Widget
 * Vanilla JS component for admin order & client detail pages.
 *
 * Usage:
 *   <div id="notes-widget" data-entity-type="order" data-entity-id="<%= order.id %>"></div>
 *   The script auto-initialises every #notes-widget on DOMContentLoaded.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  var AVATAR_COLORS = [
    '#ec1313', '#2563eb', '#7c3aed', '#059669', '#d97706',
    '#dc2626', '#0891b2', '#4f46e5', '#0d9488', '#c026d3',
  ];

  function avatarColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function initials(name) {
    var parts = (name || '').trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || '?').substring(0, 2).toUpperCase();
  }

  function timeAgo(isoStr) {
    if (!isoStr) return '';
    var diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
    if (diff < 60) return 'maintenant';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'j';
    return new Date(isoStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function nl2br(str) {
    return esc(str).replace(/\n/g, '<br>');
  }

  /* ------------------------------------------------------------------ */
  /*  Widget                                                             */
  /* ------------------------------------------------------------------ */

  function NotesWidget(container) {
    this.el = container;
    this.entityType = container.dataset.entityType || '';
    this.entityId = container.dataset.entityId || '';
    this.notes = [];
    this.editingId = null;

    if (!this.entityType || !this.entityId) {
      container.innerHTML = '';
      return;
    }
    this.render();
    this.load();
  }

  NotesWidget.prototype.apiBase = '/admin/api/notes';

  /* ---- API calls ---- */

  NotesWidget.prototype.load = function () {
    var self = this;
    fetch(this.apiBase + '?entityType=' + encodeURIComponent(this.entityType) + '&entityId=' + encodeURIComponent(this.entityId), {
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          self.notes = data.notes || [];
        } else {
          self.notes = [];
        }
        self.renderList();
      })
      .catch(function () {
        self.notes = [];
        self.renderList();
      });
  };

  NotesWidget.prototype.create = function (payload) {
    var self = this;
    return fetch(this.apiBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.note) {
          self.notes.unshift(data.note);
          self.renderList();
          return true;
        }
        alert(data && data.error ? data.error : 'Erreur lors de la creation.');
        return false;
      })
      .catch(function () {
        alert('Erreur reseau.');
        return false;
      });
  };

  NotesWidget.prototype.update = function (id, payload) {
    var self = this;
    return fetch(this.apiBase + '/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.note) {
          for (var i = 0; i < self.notes.length; i++) {
            if (self.notes[i].id === id) { self.notes[i] = data.note; break; }
          }
          self.editingId = null;
          self.renderList();
          return true;
        }
        alert(data && data.error ? data.error : 'Erreur lors de la mise a jour.');
        return false;
      });
  };

  NotesWidget.prototype.remove = function (id) {
    var self = this;
    return fetch(this.apiBase + '/' + id, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          self.notes = self.notes.filter(function (n) { return n.id !== id; });
          self.renderList();
        } else {
          alert(data && data.error ? data.error : 'Erreur lors de la suppression.');
        }
      });
  };

  NotesWidget.prototype.togglePin = function (id) {
    var self = this;
    fetch(this.apiBase + '/' + id + '/pin', {
      method: 'PATCH',
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok !== undefined) {
          for (var i = 0; i < self.notes.length; i++) {
            if (self.notes[i].id === id) { self.notes[i].isPinned = !!data.isPinned; break; }
          }
          // Re-sort: pinned first, then newest first
          self.notes.sort(function (a, b) {
            if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
            return new Date(b.createdAt) - new Date(a.createdAt);
          });
          self.renderList();
        }
      });
  };

  NotesWidget.prototype.toggleImportant = function (id) {
    var self = this;
    fetch(this.apiBase + '/' + id + '/important', {
      method: 'PATCH',
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok !== undefined) {
          for (var i = 0; i < self.notes.length; i++) {
            if (self.notes[i].id === id) { self.notes[i].isImportant = !!data.isImportant; break; }
          }
          self.renderList();
        }
      });
  };

  /* ---- Render ---- */

  NotesWidget.prototype.render = function () {
    var self = this;
    var html = '';

    // Header
    html += '<div class="flex items-center justify-between">';
    html += '  <div class="flex items-center gap-2">';
    html += '    <span class="material-symbols-outlined text-primary text-lg">sticky_note_2</span>';
    html += '    <div class="text-sm font-semibold text-slate-900">Notes internes</div>';
    html += '    <span class="nw-count text-xs font-semibold text-slate-400"></span>';
    html += '  </div>';
    html += '</div>';

    // Add form
    html += '<div class="mt-4">';
    html += '  <textarea class="nw-input w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" rows="3" placeholder="Ajouter une note interne..." maxlength="2000"></textarea>';
    html += '  <div class="mt-2 flex items-center justify-between gap-3 flex-wrap">';
    html += '    <div class="flex items-center gap-4">';
    html += '      <label class="flex items-center gap-1.5 cursor-pointer text-xs text-slate-500 select-none">';
    html += '        <input type="checkbox" class="nw-pin-cb rounded border-slate-300" /> <span>Epingler</span>';
    html += '      </label>';
    html += '      <label class="flex items-center gap-1.5 cursor-pointer text-xs text-slate-500 select-none">';
    html += '        <input type="checkbox" class="nw-imp-cb rounded border-slate-300" /> <span>Important</span>';
    html += '      </label>';
    html += '    </div>';
    html += '    <button type="button" class="nw-add-btn btn btn-primary text-xs px-4 py-2">Ajouter</button>';
    html += '  </div>';
    html += '</div>';

    // List container
    html += '<div class="nw-list mt-4 space-y-2"></div>';

    this.el.innerHTML = html;

    // Bind add button
    var textarea = this.el.querySelector('.nw-input');
    var pinCb = this.el.querySelector('.nw-pin-cb');
    var impCb = this.el.querySelector('.nw-imp-cb');
    var addBtn = this.el.querySelector('.nw-add-btn');

    addBtn.addEventListener('click', function () {
      var content = (textarea.value || '').trim();
      if (!content) { textarea.focus(); return; }

      addBtn.disabled = true;
      addBtn.textContent = '...';

      self.create({
        entityType: self.entityType,
        entityId: self.entityId,
        content: content,
        isPinned: pinCb.checked,
        isImportant: impCb.checked,
      }).then(function (ok) {
        addBtn.disabled = false;
        addBtn.textContent = 'Ajouter';
        if (ok) {
          textarea.value = '';
          pinCb.checked = false;
          impCb.checked = false;
        }
      });
    });

    // Ctrl+Enter shortcut
    textarea.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        addBtn.click();
      }
    });
  };

  NotesWidget.prototype.renderList = function () {
    var listEl = this.el.querySelector('.nw-list');
    var countEl = this.el.querySelector('.nw-count');
    if (!listEl) return;

    // Update count
    if (countEl) countEl.textContent = this.notes.length ? '(' + this.notes.length + ')' : '';

    if (!this.notes.length) {
      listEl.innerHTML = '<div class="text-sm text-slate-400 py-2">Aucune note pour le moment.</div>';
      return;
    }

    var self = this;
    var html = '';

    this.notes.forEach(function (note) {
      var isEditing = self.editingId === note.id;
      var bg = note.isImportant ? 'bg-amber-50/70' : 'bg-white';
      var borderLeft = note.isPinned ? 'border-l-[3px] border-l-blue-400' : '';
      var color = avatarColor(note.authorName || '?');
      var ini = initials(note.authorName || '?');

      html += '<div class="nw-note group rounded-xl border border-slate-100 ' + bg + ' ' + borderLeft + ' p-3 transition hover:border-slate-200" data-id="' + esc(note.id) + '">';

      // Header row
      html += '<div class="flex items-start gap-3">';

      // Avatar
      html += '<div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0" style="background:' + color + '">' + esc(ini) + '</div>';

      // Content
      html += '<div class="flex-1 min-w-0">';
      html += '<div class="flex items-center gap-2 flex-wrap">';
      html += '<span class="text-sm font-semibold text-slate-900">' + esc(note.authorName || 'Admin') + '</span>';
      html += '<span class="text-[11px] text-slate-400">' + esc(timeAgo(note.createdAt)) + '</span>';

      // Badges
      if (note.isPinned) {
        html += '<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-600 text-[10px] font-semibold">Epinglee</span>';
      }
      if (note.isImportant) {
        html += '<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-red-50 text-red-600 text-[10px] font-semibold">Important</span>';
      }
      html += '</div>';

      // Content body or edit textarea
      if (isEditing) {
        html += '<div class="mt-2">';
        html += '<textarea class="nw-edit-input w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 resize-none focus:outline-none focus:ring-2 focus:ring-primary/20" rows="3" maxlength="2000">' + esc(note.content) + '</textarea>';
        html += '<div class="mt-2 flex items-center gap-2">';
        html += '<button type="button" class="nw-save-edit btn btn-primary text-xs px-3 py-1.5">Enregistrer</button>';
        html += '<button type="button" class="nw-cancel-edit btn btn-secondary text-xs px-3 py-1.5">Annuler</button>';
        html += '</div>';
        html += '</div>';
      } else {
        html += '<div class="mt-1 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap break-words">' + nl2br(note.content) + '</div>';
      }

      html += '</div>';

      // Actions (visible on hover)
      if (note.canEdit && !isEditing) {
        html += '<div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition flex-shrink-0">';
        html += '<button type="button" class="nw-action w-7 h-7 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-action="edit" title="Modifier"><span class="material-symbols-outlined text-base text-slate-400">edit</span></button>';
        html += '<button type="button" class="nw-action w-7 h-7 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-action="pin" title="' + (note.isPinned ? 'Desepingler' : 'Epingler') + '"><span class="material-symbols-outlined text-base ' + (note.isPinned ? 'text-blue-500' : 'text-slate-400') + '">push_pin</span></button>';
        html += '<button type="button" class="nw-action w-7 h-7 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-action="important" title="' + (note.isImportant ? 'Normal' : 'Important') + '"><span class="material-symbols-outlined text-base ' + (note.isImportant ? 'text-red-500' : 'text-slate-400') + '">warning</span></button>';
        html += '<button type="button" class="nw-action w-7 h-7 rounded-lg hover:bg-red-50 flex items-center justify-center" data-action="delete" title="Supprimer"><span class="material-symbols-outlined text-base text-slate-400 hover:text-red-500">delete</span></button>';
        html += '</div>';
      }

      html += '</div>'; // flex row
      html += '</div>'; // nw-note
    });

    listEl.innerHTML = html;

    // Bind actions
    listEl.querySelectorAll('.nw-action').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var noteEl = btn.closest('.nw-note');
        var noteId = noteEl ? noteEl.dataset.id : '';
        var action = btn.dataset.action;
        if (!noteId) return;

        if (action === 'edit') {
          self.editingId = noteId;
          self.renderList();
        } else if (action === 'pin') {
          self.togglePin(noteId);
        } else if (action === 'important') {
          self.toggleImportant(noteId);
        } else if (action === 'delete') {
          if (confirm('Supprimer cette note ?')) {
            self.remove(noteId);
          }
        }
      });
    });

    // Bind edit save / cancel
    listEl.querySelectorAll('.nw-save-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var noteEl = btn.closest('.nw-note');
        var noteId = noteEl ? noteEl.dataset.id : '';
        var textarea = noteEl.querySelector('.nw-edit-input');
        var content = textarea ? textarea.value.trim() : '';
        if (!content) { if (textarea) textarea.focus(); return; }
        self.update(noteId, { content: content });
      });
    });

    listEl.querySelectorAll('.nw-cancel-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        self.editingId = null;
        self.renderList();
      });
    });
  };

  /* ---- Auto-init ---- */

  function init() {
    document.querySelectorAll('[data-notes-widget]').forEach(function (el) {
      if (!el._notesWidget) {
        el._notesWidget = new NotesWidget(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
