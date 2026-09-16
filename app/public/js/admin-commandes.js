/* ==========================================================================
   Liste des commandes — traiter une série sans recharger la page.

   Tout ce qui est DÉCIDÉ (file, retard, action suivante, file d'arrivée après
   une action) vient du serveur, dans l'attribut data-ligne de chaque ligne
   (src/services/commandesFiles.js). Ce script affiche, déclenche et annule.

   Annulation : une action n'est ENVOYÉE au serveur qu'au bout de 6 secondes.
   « Annuler » pendant ce délai n'a donc rien à défaire — aucun e-mail n'est
   parti. Une nouvelle action, un changement de page ou la fermeture de
   l'onglet envoient tout de suite l'action en attente.
   ========================================================================== */
(function () {
  'use strict';

  var page = document.querySelector('.cmd-page');
  if (!page) return;

  var DELAI_ANNULATION = 6000;
  var DUREE_MESSAGE = 2400;
  var fileActive = page.getAttribute('data-file-active') || 'all';
  var vue = page.getAttribute('data-vue') || 'active';
  var lignesEl = document.getElementById('cmdLignes');
  var toastEl = document.getElementById('cmdToast');
  var panneauEl = document.getElementById('cmdPanneau');
  var voileEl = document.getElementById('cmdVoile');
  var selectionEl = document.getElementById('cmdSelection');
  var toutCocherEl = document.getElementById('cmdToutCocher');
  var rechercheEl = document.getElementById('cmdRechercheInput');
  var rechercheFormEl = document.getElementById('cmdRecherche');

  var curseur = -1;          // index dans les lignes VISIBLES
  var ouverte = null;        // ligne affichée dans le panneau
  var enAttente = null;      // action pas encore envoyée : { lignes, timer, compteurs }
  var minuteurToast = null;

  /* ─── Utilitaires ─────────────────────────────────────────────────────── */

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function donnees(el) {
    if (!el) return null;
    if (!el._donnees) {
      try { el._donnees = JSON.parse(el.getAttribute('data-ligne') || '{}'); } catch (_) { el._donnees = {}; }
    }
    return el._donnees;
  }

  function toutesLignes() {
    return lignesEl ? Array.prototype.slice.call(lignesEl.querySelectorAll('.cmd-ligne')) : [];
  }

  function visibles() {
    return toutesLignes().filter(function (el) { return !el.hidden && !el.classList.contains('is-sortie') && !el.classList.contains('is-traitee'); });
  }

  function envoyer(url, options) {
    options = options || {};
    var entetes = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    var corps = options.body;
    if (corps && !(corps instanceof FormData)) {
      entetes['Content-Type'] = 'application/json';
      corps = JSON.stringify(corps);
    }
    return fetch(url, { method: options.method || 'POST', headers: entetes, body: corps, credentials: 'same-origin', keepalive: !!options.keepalive })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { j._statut = r.status; return j; });
      });
  }

  function confirmer(message) {
    if (typeof window.adminConfirm === 'function') return Promise.resolve(window.adminConfirm(message));
    return Promise.resolve(window.confirm(message));
  }

  /* ─── Notification unique, avec « Annuler » ───────────────────────────── */

  function notifier(message, options) {
    options = options || {};
    if (!toastEl) return;
    clearTimeout(minuteurToast);
    toastEl.querySelector('[data-toast-texte]').textContent = message;
    toastEl.querySelector('[data-toast-icone]').textContent = options.erreur ? 'error' : 'check_circle';
    toastEl.classList.toggle('is-erreur', !!options.erreur);
    var annuler = toastEl.querySelector('[data-toast-annuler]');
    annuler.hidden = !options.onAnnuler;
    annuler.onclick = options.onAnnuler ? function () { options.onAnnuler(); } : null;
    toastEl.hidden = false;
    /* Relance l'animation d'apparition. */
    toastEl.style.animation = 'none'; void toastEl.offsetWidth; toastEl.style.animation = '';
    minuteurToast = setTimeout(function () { toastEl.hidden = true; }, options.onAnnuler ? DELAI_ANNULATION : (options.duree || DUREE_MESSAGE));
  }

  /* ─── Compteurs des files ─────────────────────────────────────────────── */

  function boutonFile(id) {
    return document.querySelector('.cmd-file[data-file="' + id + '"]');
  }

  function ajusterFile(id, delta) {
    var b = boutonFile(id);
    if (!b) return;
    var n = b.querySelector('[data-file-total]');
    n.textContent = String(Math.max(0, (parseInt(n.textContent, 10) || 0) + delta));
  }

  /* Déplacement optimiste d'une ligne d'une file à l'autre. « Toutes » ne
     bouge pas ; les retards attendent la réponse du serveur. */
  function deplacerCompteurs(avant, apres, sens) {
    (avant || []).forEach(function (id) { if (id !== 'all' && (apres || []).indexOf(id) === -1) ajusterFile(id, -sens); });
    (apres || []).forEach(function (id) { if (id !== 'all' && (avant || []).indexOf(id) === -1) ajusterFile(id, sens); });
  }

  function appliquerCompteurs(compteurs, resume) {
    if (compteurs) {
      Object.keys(compteurs).forEach(function (id) {
        var b = boutonFile(id);
        if (!b) return;
        b.querySelector('[data-file-total]').textContent = String(compteurs[id].total);
        var r = b.querySelector('[data-file-retard]');
        r.querySelector('[data-file-retard-n]').textContent = String(compteurs[id].enRetard);
        r.hidden = !(compteurs[id].enRetard > 0);
      });
    }
    if (resume) {
      var el = document.querySelector('[data-resume]');
      if (el) el.textContent = resume;
    }
  }

  function majCompteLignes() {
    var el = document.querySelector('[data-compte-lignes]');
    var n = visibles().length;
    if (el && fileActive !== 'all') el.textContent = n + ' commande' + (n > 1 ? 's' : '');
    var vide = document.getElementById('cmdVide');
    var videRecherche = document.getElementById('cmdVideRecherche');
    var filtre = rechercheEl && rechercheEl.value.trim();
    var aucune = toutesLignes().filter(function (l) { return !l.classList.contains('is-sortie') && !l.classList.contains('is-partie') && !l.classList.contains('is-traitee'); }).length === 0;
    if (vide) vide.hidden = !aucune;
    if (videRecherche) videRecherche.hidden = aucune || n > 0 || !filtre;
  }

  /* ─── Curseur et sélection ────────────────────────────────────────────── */

  function poserCurseur(index, defiler) {
    var liste = visibles();
    toutesLignes().forEach(function (l) { l.classList.remove('is-curseur'); });
    if (!liste.length) { curseur = -1; return; }
    curseur = Math.max(0, Math.min(liste.length - 1, index));
    var el = liste[curseur];
    el.classList.add('is-curseur');
    if (defiler) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function ligneCurseur() {
    var liste = visibles();
    return curseur >= 0 && curseur < liste.length ? liste[curseur] : null;
  }

  function cochees() {
    return visibles().filter(function (l) { var c = l.querySelector('.cmd-check'); return c && c.checked; });
  }

  function majSelection() {
    var n = cochees().length;
    toutesLignes().forEach(function (l) {
      var c = l.querySelector('.cmd-check');
      l.classList.toggle('is-coche', !!(c && c.checked));
    });
    if (selectionEl) {
      selectionEl.hidden = n === 0;
      selectionEl.querySelector('[data-selection-n]').textContent = n + ' sélectionnée' + (n > 1 ? 's' : '');
    }
    if (toutCocherEl) {
      var total = visibles().length;
      toutCocherEl.checked = n > 0 && n === total;
      toutCocherEl.indeterminate = n > 0 && n < total;
    }
    ajusterCollants();
  }

  /* ─── Avancer une commande (différé de 6 s, annulable) ────────────────── */

  function remplacerLigne(ancienne, html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html.trim();
    var nouvelle = tmp.firstElementChild;
    if (!nouvelle) return null;
    ancienne.parentNode.replaceChild(nouvelle, ancienne);
    nouvelle.classList.add('is-arrivee');
    return nouvelle;
  }

  function envoyerLigne(item) {
    var d = donnees(item.el);
    return envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/avancer', {
      body: { action: item.action, attendu: d.etat, file: fileActive },
    }).then(function (j) {
      if (j && j.ok) {
        appliquerCompteurs(j.compteurs, j.resume);
        var dansFile = fileActive === 'all' || (j.ligne && j.ligne.files.indexOf(fileActive) !== -1);
        if (dansFile && j.ligne && j.ligne.html) {
          var nouvelle = remplacerLigne(item.el, j.ligne.html);
          if (nouvelle) nouvelle.hidden = false;
        } else if (item.bandeau) {
          /* Traitée et partie de la file : le bandeau reste où il est, sans
             « Annuler », et ne se replie que souris hors de la liste. */
          var bouton = item.bandeau.querySelector('[data-annuler-ligne]');
          if (bouton) bouton.remove();
          replierQuandLibre(item.el);
        } else if (item.el.parentNode) {
          item.el.parentNode.removeChild(item.el);
        }
        return { ok: true };
      }
      /* Refus : la ligne revient, telle que le serveur la voit si possible. */
      if (j && j.ligne && j.ligne.html && item.el.parentNode) {
        var aJour = remplacerLigne(item.el, j.ligne.html);
        if (aJour) aJour.hidden = !(fileActive === 'all' || j.ligne.files.indexOf(fileActive) !== -1);
      } else {
        restaurerLigne(item);
      }
      return { ok: false, erreur: (j && j.error) || 'Erreur : rien n’a été modifié.' };
    }).catch(function () {
      restaurerLigne(item);
      return { ok: false, erreur: 'Réseau indisponible : rien n’a été modifié.' };
    });
  }

  function restaurerLigne(item) {
    var d = donnees(item.el);
    item.el.classList.remove('is-sortie', 'is-en-cours', 'is-partie', 'is-traitee', 'is-repliee');
    if (item.bandeau && item.bandeau.parentNode) item.bandeau.parentNode.removeChild(item.bandeau);
    item.bandeau = null;
    item.el.hidden = false;
    deplacerCompteurs(d.files, d.filesApres[item.action], -1);
  }

  /* Une ligne traitée qui quitte la file ne DISPARAÎT PAS sous la souris :
     elle devient un bandeau « fait » de même hauteur. Sinon la page se
     décale d'une ligne et le clic suivant tombe sur une autre commande —
     constaté en simulant un opérateur (16/09/2026). */
  function marquerTraitee(item, texte) {
    var el = item.el;
    el.classList.add('is-traitee');
    var bandeau = document.createElement('div');
    bandeau.className = 'cmd-traitee';
    bandeau.setAttribute('role', 'status');
    bandeau.innerHTML = '<span class="ms" aria-hidden="true">check_circle</span><span class="cmd-traitee-t"></span>'
      + '<button type="button" class="cmd-traitee-annuler" data-annuler-ligne><span class="ms" aria-hidden="true">undo</span>Annuler</button>';
    bandeau.querySelector('.cmd-traitee-t').textContent = texte;
    el.appendChild(bandeau);
    item.bandeau = bandeau;
  }

  /* Le repli (hauteur réduite) décale les lignes suivantes : seulement quand
     la souris n'est pas sur la liste. */
  function replierQuandLibre(el) {
    var replier = function () { if (el.isConnected) el.classList.add('is-repliee'); };
    if (lignesEl && lignesEl.matches(':hover')) {
      lignesEl.addEventListener('mouseleave', function unique() {
        lignesEl.removeEventListener('mouseleave', unique);
        replier();
      });
    } else {
      replier();
    }
  }

  /* Envoie l'action en attente, tout de suite. */
  function validerEnAttente() {
    if (!enAttente) return Promise.resolve();
    var lot = enAttente;
    enAttente = null;
    clearTimeout(lot.timer);
    var erreurs = [];
    var chaine = Promise.resolve();
    lot.lignes.forEach(function (item) {
      chaine = chaine.then(function () {
        return envoyerLigne(item).then(function (r) { if (!r.ok) erreurs.push(r.erreur); });
      });
    });
    return chaine.then(function () {
      majCompteLignes();
      poserCurseur(curseur, false);
      if (erreurs.length) notifier(erreurs[0] + (erreurs.length > 1 ? ' (+' + (erreurs.length - 1) + ')' : ''), { erreur: true, duree: 5000 });
    });
  }

  /* Au départ de la page : l'action part quand même, sans attendre. */
  window.addEventListener('pagehide', function () {
    if (!enAttente) return;
    enAttente.lignes.forEach(function (item) {
      var d = donnees(item.el);
      envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/avancer', {
        body: { action: item.action, attendu: d.etat, file: fileActive },
        keepalive: true,
      });
    });
    enAttente = null;
  });

  function annulerEnAttente() {
    if (!enAttente) return;
    var lot = enAttente;
    enAttente = null;
    clearTimeout(lot.timer);
    lot.lignes.forEach(restaurerLigne);
    majCompteLignes();
    poserCurseur(curseur, false);
    notifier(lot.lignes.length > 1 ? lot.lignes.length + ' actions annulées' : donnees(lot.lignes[0].el).number + ' — action annulée');
  }

  /**
   * items : [{ el, action }] — actions déjà vérifiées comme possibles.
   */
  function programmer(items, message) {
    if (!items.length) return;
    validerEnAttente();
    items.forEach(function (item) {
      var d = donnees(item.el);
      var apres = d.filesApres[item.action] || d.files;
      deplacerCompteurs(d.files, apres, 1);
      var c = item.el.querySelector('.cmd-check');
      if (c) c.checked = false;
      if (fileActive !== 'all' && apres.indexOf(fileActive) === -1) {
        marquerTraitee(item, d.number + ' → ' + (MESSAGES[item.action] || 'mise à jour'));
      } else {
        item.el.classList.add('is-en-cours');
      }
    });
    majSelection();
    majCompteLignes();
    poserCurseur(curseur, false);
    enAttente = { lignes: items, timer: setTimeout(validerEnAttente, DELAI_ANNULATION) };
    notifier(message, { onAnnuler: annulerEnAttente });
  }

  /* Seule action de la liste qui écrit au client : « Livrée ». Le passage en
     préparation (« Oui », « Commandée », « Reçue atelier ») reste silencieux
     côté serveur (postAdminAvancerCommande). */
  function previentClient(d, actionId) {
    return actionId === 'livree';
  }

  var MESSAGES = {
    en_stock: 'pièce en stock, en préparation',
    a_commander: 'pièce à commander',
    commandee: 'commandée au fournisseur',
    recue: 'reçue à l’atelier',
    expediee: 'expédiée',
    livree: 'livrée',
    terminer: 'terminée',
  };

  /* Demande d'action depuis une ligne (bouton, touche A, panneau). */
  function agir(el, actionId) {
    var d = donnees(el);
    if (!d) return;
    if (!actionId) {
      var a = d.action;
      if (!a) return;
      if (a.besoin === 'decision') { ouvrirPanneau(el, 'appro'); return; }
      if (a.besoin === 'etiquette' || a.besoin === 'suivi') {
        ouvrirPanneau(el, 'expedition');
        if (a.besoin === 'suivi') notifier(d.number + ' — renseigne le numéro de suivi avant de passer en expédiée', { erreur: true });
        return;
      }
      if (a.besoin === 'retour') { notifier(d.number + ' — l’ancienne pièce n’est pas revenue : le dossier reste ouvert', { erreur: true }); return; }
      actionId = a.id;
    }
    if (!actionId || (d.actionsPossibles || []).indexOf(actionId) === -1) return;
    programmer([{ el: el, action: actionId }], d.number + ' → ' + (MESSAGES[actionId] || 'mise à jour')
      + (previentClient(d, actionId) ? ' · e-mail au client dans 6 s' : ''));
  }

  /* ─── Panneau latéral ─────────────────────────────────────────────────── */

  var TONS_STATUT = {
    draft: 'gris', pending_payment: 'ambre', paid: 'vert', processing: 'bleu', label_created: 'ambre',
    shipped: 'bleu', delivered: 'vert', completed: 'gris', cancelled: 'rouge', refunded: 'gris', partially_refunded: 'gris',
  };
  var LIBELLES_APPRO = { a_verifier: 'À vérifier', a_commander: 'À commander', commandee: 'Commandée (fournisseur)', en_stock: 'En stock / reçue' };

  function champPanneau(nom) { return panneauEl ? panneauEl.querySelector('[data-p="' + nom + '"]') : null; }

  function blocAvancement(p) {
    return '<section class="cmd-bloc"><h3>Avancement</h3><div class="cmd-etapes">'
      + (p.avancement || []).map(function (e) {
        return '<div class="cmd-etape is-' + esc(e.etat) + '"><span class="cmd-etape-point" aria-hidden="true"></span>'
          + '<span>' + esc(e.label) + '</span><span class="cmd-etape-meta">' + esc(e.meta) + '</span></div>';
      }).join('') + '</div></section>';
  }

  function blocAppro(p) {
    var a = p.appro || {};
    var decision = p.action && p.action.besoin === 'decision';
    var aide = decision
      ? 'Tranche l’appro sans quitter la file : en stock, la commande part en préparation ; sinon elle rejoint « À commander ».'
      : 'Modifier l’appro ici recalcule la file et l’alerte de retard fournisseur. La date de réception prévue fixe le délai attendu.';
    var options = Object.keys(LIBELLES_APPRO).map(function (k) {
      /* Commande partie : l'appro affichée est celle qui compte (« en stock »). */
      var choisi = a.pertinente ? a.brut : a.cle;
      return '<option value="' + k + '"' + (choisi === k ? ' selected' : '') + '>' + LIBELLES_APPRO[k] + '</option>';
    }).join('');
    return '<section class="cmd-bloc" data-section="appro"><h3>Approvisionnement de la pièce</h3>'
      + '<p class="cmd-bloc-aide">' + esc(aide) + '</p>'
      + (decision
        ? '<div class="cmd-bloc-actions" style="margin:0 0 14px">'
          + '<button type="button" class="cmd-choix is-oui" data-panneau-action="en_stock"><span class="ms" aria-hidden="true">check_circle</span>En stock</button>'
          + '<button type="button" class="cmd-choix is-commander" data-panneau-action="a_commander"><span class="ms" aria-hidden="true">shopping_cart</span>À commander</button></div>'
        : '')
      + '<form data-form="appro"><div class="cmd-champs">'
      + '<label class="cmd-champ">Statut appro<select name="status"' + (a.pertinente ? '' : ' disabled') + '>' + options + '</select></label>'
      + '<label class="cmd-champ">Commandée le<input type="date" name="orderedAt" value="' + esc(a.commandeeLe) + '"' + (a.pertinente ? '' : ' disabled') + ' /></label>'
      + '<label class="cmd-champ">Réception prévue<input type="date" name="receptionPrevue" value="' + esc(a.receptionPrevue) + '"' + (a.pertinente ? '' : ' disabled') + ' /></label>'
      + '<label class="cmd-champ is-large">Note d’appro<textarea name="note" rows="2" placeholder="Fournisseur, délai annoncé, référence commandée…"' + (a.pertinente ? '' : ' disabled') + '>' + esc(a.note) + '</textarea></label>'
      + '</div>'
      + (a.pertinente ? '<div class="cmd-bloc-actions"><button type="submit" class="cmd-bouton is-petit">Enregistrer l’appro</button></div>' : '<p class="cmd-bloc-aide" style="margin:10px 0 0">Commande partie : rien à faire côté appro.</p>')
      + '</form>'
      + '<div class="cmd-bloc-info">'
      + (a.fournisseur ? 'Fournisseur (achat) : <strong>' + esc(a.fournisseur) + '</strong>' : 'Aucun fournisseur saisi dans l’achat de la commande')
      + (a.majLe ? ' · appro mise à jour le ' + esc(a.majLe) + (a.majPar ? ' par ' + esc(a.majPar) : '') : '')
      + '</div></section>';
  }

  function blocExpedition(p) {
    var a = p.action || {};
    var besoin = a.besoin === 'etiquette' || a.besoin === 'suivi';
    var envois = p.envois || [];
    var labels = ['Envoi', 'Envoi partiel'];
    if (p.clonage) labels.push('Récupération clonage');
    labels.push('Retour');
    return '<section class="cmd-bloc' + (besoin ? ' is-attention' : '') + '" data-section="expedition">'
      + '<h3>' + (envois.length ? 'Expédition' : 'Aucune étiquette d’expédition enregistrée') + '</h3>'
      + (envois.length
        ? '<ul class="cmd-envois">' + envois.map(function (e) {
          return '<li>' + esc(e.label || 'Envoi') + ' · ' + esc(e.transporteur || 'transporteur ?') + ' · <strong>' + esc(e.suivi) + '</strong>' + (e.le ? ' · ' + esc(e.le) : '') + '</li>';
        }).join('') + '</ul>'
        : '<p class="cmd-bloc-aide" style="margin:0 0 12px">Ajoute l’étiquette et son numéro de suivi pour pouvoir passer la commande en expédiée.</p>')
      + '<form data-form="expedition" enctype="multipart/form-data" style="margin-top:12px"><div class="cmd-champs">'
      + '<label class="cmd-champ">Type<select name="label">' + labels.map(function (l) { return '<option>' + esc(l) + '</option>'; }).join('') + '</select></label>'
      + '<label class="cmd-champ">Numéro de suivi<input type="text" name="trackingNumber" required autocomplete="off" /></label>'
      + '<label class="cmd-champ">Transporteur<input type="text" name="carrier" list="cmdTransporteurs" autocomplete="off" /></label>'
      + '<label class="cmd-champ">Étiquette PDF<input type="file" name="document" accept="application/pdf" /></label>'
      + '</div>'
      + '<datalist id="cmdTransporteurs"><option>Jumingo</option><option>DHL</option><option>UPS</option><option>FedEx</option><option>Colissimo</option><option>Chronopost</option><option>DPD</option><option>GLS</option><option>TNT</option><option>Geodis</option></datalist>'
      + '<label class="cmd-champ" style="flex-direction:row;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" name="stampDocument" value="on" checked style="width:16px;min-height:0" />Tamponner le n° de commande sur le PDF</label>'
      + '<p class="cmd-bloc-avertissement">À l’enregistrement, le client reçoit ce numéro de suivi par e-mail.</p>'
      + '<div class="cmd-bloc-actions"><button type="submit" class="cmd-act"><span class="ms" aria-hidden="true">add</span>Ajouter une étiquette et un suivi</button></div>'
      + '</form></section>';
  }

  function dateLongue(aaaammjj) {
    var d = new Date(aaaammjj + 'T12:00:00');
    return isNaN(d.getTime()) ? aaaammjj : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* Date de livraison ANNONCÉE AU CLIENT — « Réception prévue », dans l'appro,
     reste la date interne du fournisseur. */
  function blocLivraison(p) {
    var l = p.livraison || {};
    if (!l.pertinente) return '';
    var info = l.annonceePour
      ? 'Dernière date envoyée au client : ' + dateLongue(l.annonceePour) + (l.annonceeLe ? ' (e-mail du ' + l.annonceeLe + ')' : '')
      : 'Aucune date envoyée au client pour l’instant.';
    return '<section class="cmd-bloc" data-section="livraison"><h3>Livraison prévue</h3>'
      + '<form data-form="livraison"><div class="cmd-champs">'
      + '<label class="cmd-champ">Date annoncée au client<input type="date" name="date" value="' + esc(l.date) + '" min="' + esc(l.aujourdhui) + '" /></label>'
      + '</div>'
      + '<p class="cmd-bloc-avertissement">' + (l.emailClient
        ? 'Chaque nouvelle date part au client par e-mail. La même date enregistrée deux fois n’envoie rien.'
        : 'Aucun e-mail client sur cette commande : la date sera enregistrée sans prévenir le client.') + '</p>'
      + '<div class="cmd-bloc-actions"><button type="submit" class="cmd-act"><span class="ms" aria-hidden="true">event</span>' + (l.emailClient ? 'Enregistrer et prévenir le client' : 'Enregistrer la date') + '</button>'
      + (l.date ? '<button type="button" class="cmd-bouton is-petit" data-retirer-livraison>Retirer la date</button>' : '')
      + '</div></form>'
      + '<div class="cmd-bloc-info">' + esc(info) + '</div></section>';
  }

  function blocPieces(p, d) {
    var dernier = (p.envois || []).length ? p.envois[p.envois.length - 1] : null;
    return '<section class="cmd-bloc"><h3>Pièce et transport</h3><div class="cmd-pieces">'
      + (p.pieces || []).map(function (it) {
        return '<div><div class="cmd-piece-l">' + esc(it.qte) + ' × ' + esc(it.nom) + '</div>'
          + (it.sku ? '<div class="cmd-bloc-actions" style="margin-top:6px"><span class="cmd-code">' + esc(it.sku) + '</span>'
            + '<button type="button" class="cmd-copier" data-copier="' + esc(it.sku) + '"><span class="ms" aria-hidden="true">content_copy</span>Copier la réf</button></div>' : '')
          + '</div>';
      }).join('') + '</div>'
      + '<div class="cmd-deux">'
      + '<div><div class="cmd-etiquette">Montant</div><div class="cmd-valeur">' + esc(p.montant) + '</div><div class="cmd-valeur-s">' + esc(p.paiement) + '</div></div>'
      + '<div><div class="cmd-etiquette">Transport</div><div class="cmd-valeur" style="font-size:14px">' + esc(dernier ? (dernier.transporteur || '—') : '—') + '</div><div class="cmd-valeur-s">' + esc(dernier ? dernier.suivi : 'à créer') + '</div></div>'
      + '</div></section>';
  }

  function blocClient(p, d) {
    var c = p.client || {};
    return '<section class="cmd-bloc"><h3>Client</h3>'
      + '<div style="font-size:14px;font-weight:600">' + esc(c.nom) + '</div>'
      + (c.email ? '<div class="cmd-valeur-s"><a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></div>' : '')
      + (c.telephone ? '<div class="cmd-valeur-s"><a href="tel:' + esc(String(c.telephone).replace(/\s/g, '')) + '">' + esc(c.telephone) + '</a></div>' : '')
      + '<div class="cmd-liens">'
      + '<a class="cmd-bouton is-petit" href="/admin/commandes/' + esc(p.id) + '"><span class="ms" aria-hidden="true">description</span>Fiche complète</a>'
      + (d.etiquette ? '<a class="cmd-bouton is-petit" href="' + esc(d.etiquette) + '" target="_blank" rel="noopener" data-imprimer><span class="ms" aria-hidden="true">print</span>Étiquette</a>' : '')
      + (c.email ? '<a class="cmd-bouton is-petit" href="mailto:' + esc(c.email) + '?subject=' + encodeURIComponent('Votre commande ' + p.number) + '"><span class="ms" aria-hidden="true">mail</span>Email client</a>' : '')
      + '</div></section>';
  }

  function blocNote(p) {
    return '<section class="cmd-bloc"><h3>Note interne</h3>'
      + '<form data-form="note"><label class="cmd-champ"><span class="sr-only">Note interne</span>'
      + '<textarea name="content" rows="3" maxlength="2000" placeholder="Fournisseur, délai annoncé, particularité de montage…"></textarea></label>'
      + '<div class="cmd-bloc-actions"><button type="submit" class="cmd-bouton is-petit">Ajouter la note</button>'
      + (p.notes ? '<span class="cmd-valeur-s">' + esc(p.notes) + ' note' + (p.notes > 1 ? 's' : '') + ' — voir la fiche complète</span>' : '')
      + '</div></form></section>';
  }

  /* Plaque et VIN en tête du panneau : c'est ce qu'on recopie chez le
     fournisseur pour vérifier la compatibilité de la pièce. */
  function blocVehicule(p) {
    var v = p.vehicule || {};
    var puce = function (libelle, valeur, genre) {
      return '<span class="cmd-vehicule"><span class="cmd-vehicule-l">' + esc(libelle) + '</span>'
        + '<strong class="cmd-vehicule-v">' + esc(valeur) + '</strong>'
        + '<button type="button" class="cmd-vehicule-copier" data-copier="' + esc(valeur) + '" data-copier-libelle="' + esc(libelle) + '" data-copier-genre="' + genre + '" title="Copier" aria-label="Copier ' + esc(libelle) + ' ' + esc(valeur) + '"><span class="ms" aria-hidden="true">content_copy</span></button></span>';
    };
    var html = (v.plaque ? puce('Plaque', v.plaque, 'f') : '') + (v.vin ? puce('VIN', v.vin, 'm') : '')
      + (v.saisie ? puce('Plaque / VIN saisi', v.saisie, 'm') : '');
    return html || '<span class="cmd-vehicule is-vide"><span class="ms" aria-hidden="true">directions_car</span>Plaque / VIN non renseignés</span>';
  }

  function remplirPanneau(el, section) {
    var d = donnees(el);
    var p = d.panneau || {};
    champPanneau('number').textContent = p.number || d.number;
    var statut = champPanneau('statut');
    statut.textContent = p.statusLabel || '';
    statut.className = 'cmd-statut is-' + (TONS_STATUT[p.statusKey] || 'gris');
    champPanneau('subline').textContent = p.subline || '';
    var vehicule = champPanneau('vehicule');
    if (vehicule) vehicule.innerHTML = blocVehicule(p);

    var corps = champPanneau('corps');
    var action = p.action || {};
    var expeditionD_abord = action.besoin === 'etiquette' || action.besoin === 'suivi';
    corps.innerHTML = blocAvancement(p)
      + (expeditionD_abord ? blocExpedition(p) + blocAppro(p) : blocAppro(p) + blocExpedition(p))
      + blocLivraison(p) + blocPieces(p, d) + blocClient(p, d) + blocNote(p);

    var liste = visibles();
    var i = liste.indexOf(el);
    champPanneau('position').textContent = i >= 0 ? (i + 1) + ' / ' + liste.length : '';

    var primaire = champPanneau('primaire');
    primaire.hidden = true;
    primaire.onclick = null;
    if (action.besoin === 'decision') {
      primaire.innerHTML = '<span class="ms" aria-hidden="true">warehouse</span>En stock — passer en préparation';
      primaire.hidden = false;
      primaire.onclick = function () { actionDepuisPanneau('en_stock'); };
    } else if (action.besoin === 'etiquette' || action.besoin === 'suivi') {
      primaire.innerHTML = '<span class="ms" aria-hidden="true">label</span>Saisir l’étiquette et le suivi';
      primaire.hidden = false;
      primaire.onclick = function () { focaliserSection('expedition'); };
    } else if (action.id) {
      primaire.innerHTML = '<span class="ms" aria-hidden="true">' + esc(action.icon) + '</span>' + esc(action.label);
      primaire.hidden = false;
      primaire.onclick = function () { actionDepuisPanneau(action.id); };
    }

    if (section) setTimeout(function () { focaliserSection(section); }, 30);
  }

  function focaliserSection(section) {
    var bloc = panneauEl && panneauEl.querySelector('[data-section="' + section + '"]');
    if (!bloc) return;
    bloc.scrollIntoView({ block: 'start', behavior: 'smooth' });
    var champ = bloc.querySelector(section === 'expedition' ? 'input[name="trackingNumber"]' : 'select, input, textarea');
    if (champ && !champ.disabled) champ.focus({ preventScroll: true });
  }

  function ouvrirPanneau(el, section) {
    if (!panneauEl || !el) return;
    ouverte = el;
    var liste = visibles();
    var i = liste.indexOf(el);
    if (i >= 0) poserCurseur(i, true);
    remplirPanneau(el, section);
    panneauEl.hidden = false;
    voileEl.hidden = false;
    if (!section) panneauEl.querySelector('[data-fermer]').focus({ preventScroll: true });
  }

  function fermerPanneau() {
    if (!panneauEl || panneauEl.hidden) return false;
    panneauEl.hidden = true;
    voileEl.hidden = true;
    var retour = ouverte;
    ouverte = null;
    if (retour && retour.isConnected) {
      var bouton = retour.querySelector('[data-ouvrir="panneau"]');
      if (bouton) bouton.focus({ preventScroll: true });
    }
    return true;
  }

  function naviguerPanneau(sens) {
    var liste = visibles();
    if (!liste.length) { fermerPanneau(); return; }
    var i = ouverte ? liste.indexOf(ouverte) : curseur;
    if (i === -1) i = Math.min(curseur, liste.length - 1);
    var j = Math.max(0, Math.min(liste.length - 1, i + sens));
    ouvrirPanneau(liste[j]);
  }

  function actionDepuisPanneau(actionId) {
    var el = ouverte;
    if (!el) return;
    var liste = visibles();
    var index = liste.indexOf(el);
    agir(el, actionId);
    /* On enchaîne : le panneau passe à la commande suivante de la file. */
    setTimeout(function () {
      var reste = visibles();
      if (!reste.length) { fermerPanneau(); return; }
      var sortie = el.hidden || el.classList.contains('is-partie') || el.classList.contains('is-traitee');
      var suivante = sortie ? reste[Math.min(index, reste.length - 1)] : (reste[index + 1] || el);
      ouvrirPanneau(suivante);
    }, 260);
  }

  /* Après une saisie dans le panneau : la ligne à jour, et le panneau aussi
     si elle reste dans la file. */
  function rafraichirLigne(el, message) {
    var d = donnees(el);
    return envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/ligne?file=' + encodeURIComponent(fileActive), { method: 'GET' })
      .then(function (j) {
        if (!j || !j.ok) { notifier((j && j.error) || 'La ligne n’a pas pu être rechargée.', { erreur: true }); return; }
        appliquerLigneAJour(el, j, message);
      });
  }

  /* Réponse { ligne, compteurs, resume } d'un endpoint : ligne remplacée,
     compteurs à jour, panneau rafraîchi si la commande reste dans la file. */
  function appliquerLigneAJour(el, j, message, options) {
    var d = donnees(el);
    appliquerCompteurs(j.compteurs, j.resume);
    var dansFile = fileActive === 'all' || j.ligne.files.indexOf(fileActive) !== -1;
    var nouvelle = remplacerLigne(el, j.ligne.html);
    if (!nouvelle) return;
    if (!dansFile) {
      nouvelle.hidden = true;
      nouvelle.classList.add('is-partie');
      majCompteLignes();
      notifier((message ? message + ' · ' : '') + d.number + ' quitte la file', options);
      if (ouverte === el) naviguerPanneau(0);
    } else {
      if (message) notifier(message, options);
      if (ouverte === el) { ouverte = nouvelle; remplirPanneau(nouvelle); }
    }
  }

  function soumettreAppro(form) {
    var el = ouverte;
    var d = donnees(el);
    var f = form.elements;
    var corps = { status: f.status.value, note: f.note.value };
    if (f.orderedAt.value) corps.orderedAt = f.orderedAt.value;
    if (f.receptionPrevue.value) {
      var depart = f.orderedAt.value ? new Date(f.orderedAt.value + 'T12:00:00') : new Date();
      var arrivee = new Date(f.receptionPrevue.value + 'T12:00:00');
      var jours = Math.round((arrivee - depart) / 86400000);
      if (jours > 0) corps.expectedDays = jours;
    }
    var bouton = form.querySelector('[type="submit"]');
    if (bouton) bouton.disabled = true;
    validerEnAttente().then(function () {
      return envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/sourcing', { body: corps });
    }).then(function (j) {
      if (!j || !j.ok) { notifier((j && j.error) || 'Appro non enregistrée.', { erreur: true }); if (bouton) bouton.disabled = false; return; }
      return rafraichirLigne(el, d.number + ' → appro enregistrée');
    }).catch(function () { notifier('Réseau indisponible : appro non enregistrée.', { erreur: true }); if (bouton) bouton.disabled = false; });
  }

  function soumettreExpedition(form) {
    var el = ouverte;
    var d = donnees(el);
    var donneesForm = new FormData(form);
    if (!String(donneesForm.get('trackingNumber') || '').trim()) { form.querySelector('[name="trackingNumber"]').focus(); return; }
    var fichier = donneesForm.get('document');
    if (fichier && !fichier.size) donneesForm.delete('document');
    if (!form.querySelector('[name="stampDocument"]').checked) donneesForm.delete('stampDocument');
    var bouton = form.querySelector('[type="submit"]');
    if (bouton) bouton.disabled = true;
    validerEnAttente().then(function () {
      return envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/suivi', { body: donneesForm });
    }).then(function (j) {
      if (!j || !j.ok) { notifier((j && j.error) || 'Suivi non enregistré.', { erreur: true }); if (bouton) bouton.disabled = false; return; }
      return rafraichirLigne(el, d.number + ' → étiquette et suivi enregistrés');
    }).catch(function () { notifier('Réseau indisponible : suivi non enregistré.', { erreur: true }); if (bouton) bouton.disabled = false; });
  }

  var RAISONS_EMAIL = {
    missing_api_key: 'envoi d’e-mails non configuré',
    missing_from_email: 'expéditeur non configuré',
    missing_to_email: 'adresse client manquante',
  };

  function soumettreLivraison(form, retirer) {
    var el = ouverte;
    var d = donnees(el);
    var l = (d.panneau && d.panneau.livraison) || {};
    var date = retirer ? '' : form.elements.date.value;
    if (!retirer && !date) { form.elements.date.focus(); return; }
    if (!retirer && l.aujourdhui && date < l.aujourdhui) { notifier('Cette date est déjà passée.', { erreur: true }); form.elements.date.focus(); return; }
    var prevenir = !retirer && l.emailClient && date !== l.annonceePour;
    var question = retirer
      ? 'Retirer la date de livraison de ' + d.number + ' ? Le client n’est pas prévenu.'
      : (prevenir ? 'Le client de ' + d.number + ' va recevoir un e-mail : livraison prévue le ' + dateLongue(date) + '. Continuer ?' : null);
    (question ? confirmer(question) : Promise.resolve(true)).then(function (ok) {
      if (!ok) return;
      var boutons = Array.prototype.slice.call(form.querySelectorAll('button'));
      var reactiver = function () { boutons.forEach(function (b) { b.disabled = false; }); };
      boutons.forEach(function (b) { b.disabled = true; });
      validerEnAttente().then(function () {
        return envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/livraison-prevue', { body: { date: date, file: fileActive } });
      }).then(function (j) {
        if (!j || !j.ok) { notifier((j && j.error) || 'Date non enregistrée.', { erreur: true }); reactiver(); return; }
        var e = j.email || {};
        var message;
        var options;
        if (retirer) message = d.number + ' → date de livraison retirée';
        else if (e.envoye) message = d.number + ' → date envoyée au client par e-mail';
        else if (e.raison === 'meme_date') message = d.number + ' → date enregistrée · déjà envoyée au client, pas de nouvel e-mail';
        else if (e.raison === 'sans_email') message = d.number + ' → date enregistrée · pas d’e-mail client sur la commande';
        else if (e.raison === 'en_cours') message = d.number + ' → date enregistrée · e-mail déjà en cours d’envoi';
        else {
          message = d.number + ' → date enregistrée, mais l’e-mail n’est PAS parti (' + (RAISONS_EMAIL[e.raison] || e.raison || 'erreur') + ')';
          options = { erreur: true, duree: 8000 };
        }
        appliquerLigneAJour(el, j, message, options);
      }).catch(function () { notifier('Réseau indisponible : date non enregistrée.', { erreur: true }); reactiver(); });
    });
  }

  function soumettreNote(form) {
    var el = ouverte;
    var d = donnees(el);
    var contenu = form.elements.content.value.trim();
    if (!contenu) { form.elements.content.focus(); return; }
    var bouton = form.querySelector('[type="submit"]');
    if (bouton) bouton.disabled = true;
    envoyer('/admin/api/notes', { body: { entityType: 'order', entityId: d.id, content: contenu } })
      .then(function (j) {
        if (!j || !j.ok) { notifier((j && j.error) || 'Note non enregistrée.', { erreur: true }); if (bouton) bouton.disabled = false; return; }
        return rafraichirLigne(el, 'Note ajoutée à ' + d.number);
      })
      .catch(function () { notifier('Réseau indisponible : note non enregistrée.', { erreur: true }); if (bouton) bouton.disabled = false; });
  }

  if (panneauEl) {
    panneauEl.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-form]');
      if (!form) return;
      e.preventDefault();
      var type = form.getAttribute('data-form');
      if (type === 'appro') soumettreAppro(form);
      else if (type === 'expedition') soumettreExpedition(form);
      else if (type === 'livraison') soumettreLivraison(form, false);
      else if (type === 'note') soumettreNote(form);
    });
    panneauEl.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-fermer]')) { fermerPanneau(); return; }
      var nav = t.closest('[data-panneau-nav]');
      if (nav) { naviguerPanneau(parseInt(nav.getAttribute('data-panneau-nav'), 10)); return; }
      var act = t.closest('[data-panneau-action]');
      if (act) { actionDepuisPanneau(act.getAttribute('data-panneau-action')); return; }
      var retirer = t.closest('[data-retirer-livraison]');
      if (retirer) { soumettreLivraison(retirer.closest('form'), true); return; }
      var copier = t.closest('[data-copier]');
      if (copier) {
        var ref = copier.getAttribute('data-copier');
        var libelle = copier.getAttribute('data-copier-libelle') || 'Référence';
        var accord = copier.getAttribute('data-copier-genre') === 'm' ? ' copié' : ' copiée';
        if (navigator.clipboard) navigator.clipboard.writeText(ref).then(function () { notifier(libelle + ' ' + ref + accord); });
        return;
      }
      var imprimer = t.closest('[data-imprimer]');
      if (imprimer) { e.preventDefault(); imprimerEtiquette(imprimer.getAttribute('href')); }
    });
    voileEl.addEventListener('click', fermerPanneau);
  }

  /* ─── Actions groupées ────────────────────────────────────────────────── */

  function actionsGroupees(type) {
    var lignes = cochees();
    if (!lignes.length) return;
    if (type === 'avancer') {
      var items = [];
      var ignorees = 0;
      lignes.forEach(function (el) {
        var possibles = donnees(el).actionsPossibles || [];
        if (possibles.length === 1) items.push({ el: el, action: possibles[0] });
        else ignorees += 1;
      });
      if (!items.length) {
        notifier('Rien à avancer d’un clic : ces commandes demandent une décision ou une saisie (appro, étiquette, suivi).', { erreur: true, duree: 5000 });
        return;
      }
      var lancer = function () {
        programmer(items, items.length + ' commande' + (items.length > 1 ? 's avancées' : ' avancée')
          + (ignorees ? ' · ' + ignorees + ' à traiter une par une' : ''));
      };
      /* En masse, un e-mail au client part pour chaque commande concernée —
         y compris pour une vieille commande restée à la mauvaise étape. */
      var livrees = items.filter(function (it) { return previentClient(donnees(it.el), it.action); }).length;
      if (livrees) {
        confirmer('Des clients vont recevoir un e-mail : ' + livrees + ' commande' + (livrees > 1 ? 's passeront' : ' passera')
          + ' en « Livrée » (e-mail de livraison, et délai de retour de consigne compté à partir d’aujourd’hui). Continuer ?')
          .then(function (ok) { if (ok) lancer(); });
        return;
      }
      lancer();
      return;
    }
    var ids = lignes.map(function (el) { return donnees(el).id; });
    if (type === 'etiquettes') {
      var avec = lignes.filter(function (el) { return donnees(el).etiquette; }).map(function (el) { return donnees(el).id; });
      if (!avec.length) { notifier('Aucune étiquette PDF jointe à ces commandes.', { erreur: true }); return; }
      window.open('/admin/commandes/etiquettes.pdf?ids=' + avec.join(','), '_blank', 'noopener');
      if (avec.length < ids.length) notifier((ids.length - avec.length) + ' commande(s) sans étiquette jointe, ignorée(s).');
      return;
    }
    if (type === 'avis') {
      if (ids.length > 50) { notifier('50 commandes au plus par envoi de demandes d’avis.', { erreur: true }); return; }
      confirmer('Envoyer une demande d’avis à ' + ids.length + ' client' + (ids.length > 1 ? 's' : '') + ' via Avis Vérifiés ?').then(function (ok) {
        if (!ok) return;
        envoyer('/admin/commandes/demande-avis-multi', { body: { orderIds: ids } }).then(function (j) {
          if (j && j.ok) {
            var msg = (j.sent || 0) + ' demande(s) d’avis envoyée(s)';
            if (j.skipped && j.skipped.length) msg += ' · ' + j.skipped.length + ' ignorée(s) : ' + j.skipped.map(function (s) { return s.number + ' (' + s.reason + ')'; }).join(', ');
            notifier(msg, { duree: 6000 });
          } else {
            notifier('Échec : ' + ((j && j.error) || 'erreur inconnue'), { erreur: true });
          }
        }).catch(function () { notifier('Réseau indisponible.', { erreur: true }); });
      });
      return;
    }
    if (type === 'corbeille') {
      confirmer('Mettre ' + ids.length + ' commande' + (ids.length > 1 ? 's' : '') + ' à la corbeille ? Restaurable pendant 30 jours.').then(function (ok) {
        if (!ok) return;
        validerEnAttente().then(function () {
          return envoyer('/admin/commandes/corbeille-multi', { body: { orderIds: ids } });
        }).then(function (j) {
          if (!j || !j.ok) { notifier((j && j.error) || 'Échec de la mise à la corbeille.', { erreur: true }); return; }
          lignes.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
          appliquerCompteurs(j.compteurs, j.resume);
          majSelection();
          majCompteLignes();
          poserCurseur(curseur, false);
          notifier(j.message);
        }).catch(function () { notifier('Réseau indisponible.', { erreur: true }); });
      });
    }
  }

  if (selectionEl) {
    selectionEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-groupe]');
      if (b) actionsGroupees(b.getAttribute('data-groupe'));
    });
  }
  if (toutCocherEl) {
    toutCocherEl.addEventListener('change', function () {
      visibles().forEach(function (el) { var c = el.querySelector('.cmd-check'); if (c) c.checked = toutCocherEl.checked; });
      majSelection();
    });
  }

  /* ─── Menu « ••• » d'une ligne ────────────────────────────────────────── */

  function fermerMenus(sauf) {
    document.querySelectorAll('.cmd-menu-l').forEach(function (m) {
      if (m === sauf) return;
      m.hidden = true;
      var b = m.parentNode.querySelector('.cmd-plus');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  function actionMenu(el, type) {
    var d = donnees(el);
    if (type === 'avis') {
      confirmer('Envoyer une demande d’avis au client de ' + d.number + ' ?').then(function (ok) {
        if (!ok) return;
        envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/demande-avis', { body: {} }).then(function (j) {
          notifier(j && j.ok ? 'Demande d’avis envoyée pour ' + d.number : 'Échec : ' + ((j && (j.error || j.message)) || 'erreur inconnue'), { erreur: !(j && j.ok) });
        });
      });
      return;
    }
    var url = type === 'archiver' ? '/archiver' : '/supprimer';
    var question = type === 'archiver'
      ? 'Archiver ' + d.number + ' ? Elle sort de la liste et des statistiques, réversible.'
      : 'Mettre ' + d.number + ' à la corbeille ? Restaurable pendant 30 jours.';
    confirmer(question).then(function (ok) {
      if (!ok) return;
      validerEnAttente().then(function () {
        return envoyer('/admin/commandes/' + encodeURIComponent(d.id) + url, { body: {} });
      }).then(function (j) {
        if (!j || !j.ok) { notifier((j && (j.message || j.error)) || 'Échec.', { erreur: true }); return; }
        if (el.parentNode) el.parentNode.removeChild(el);
        majSelection();
        majCompteLignes();
        poserCurseur(curseur, false);
        notifier(d.number + (type === 'archiver' ? ' archivée' : ' mise à la corbeille'));
        /* Les compteurs, à partir d'une commande qui existe toujours. */
        envoyer('/admin/commandes/' + encodeURIComponent(d.id) + '/ligne', { method: 'GET' }).then(function (r) { if (r && r.ok) appliquerCompteurs(r.compteurs, r.resume); });
      }).catch(function () { notifier('Réseau indisponible.', { erreur: true }); });
    });
  }

  function imprimerEtiquette(url) {
    var w = window.open(url, '_blank', 'width=800,height=600');
    if (w) w.addEventListener('load', function () { setTimeout(function () { try { w.print(); } catch (_) { /* aperçu PDF */ } }, 500); });
  }

  /* ─── Clics dans le tableau ───────────────────────────────────────────── */

  if (lignesEl) {
    lignesEl.addEventListener('click', function (e) {
      var t = e.target;
      var el = t.closest('.cmd-ligne');
      if (!el || vue !== 'active') return;
      if (el.classList.contains('is-traitee')) {
        if (t.closest('[data-annuler-ligne]') && enAttente && enAttente.lignes.some(function (it) { return it.el === el; })) annulerEnAttente();
        return;
      }

      var plus = t.closest('.cmd-plus');
      if (plus) {
        var menu = plus.parentNode.querySelector('.cmd-menu-l');
        var ouvrir = menu.hidden;
        fermerMenus(menu);
        menu.hidden = !ouvrir;
        plus.setAttribute('aria-expanded', ouvrir ? 'true' : 'false');
        if (ouvrir) { var premier = menu.querySelector('a, button'); if (premier) premier.focus(); }
        return;
      }
      var itemMenu = t.closest('[data-menu]');
      if (itemMenu) { fermerMenus(); actionMenu(el, itemMenu.getAttribute('data-menu')); return; }
      if (t.closest('.cmd-menu-l a')) return;

      var imprimer = t.closest('[data-imprimer]');
      if (imprimer) { e.preventDefault(); imprimerEtiquette(imprimer.getAttribute('href')); return; }

      var liste = visibles();
      var index = liste.indexOf(el);

      var bouton = t.closest('[data-action]');
      if (bouton) { if (index >= 0) poserCurseur(index, false); agir(el, bouton.getAttribute('data-action')); return; }

      var ouvreur = t.closest('[data-ouvrir]');
      if (ouvreur) {
        var section = ouvreur.getAttribute('data-ouvrir');
        ouvrirPanneau(el, section === 'panneau' ? null : section);
        var msg = ouvreur.getAttribute('data-message');
        if (msg) notifier(msg, { erreur: true });
        return;
      }

      if (t.closest('a, button, input, label, select, textarea, form')) return;
      ouvrirPanneau(el);
    });

    lignesEl.addEventListener('change', function (e) {
      if (e.target.classList.contains('cmd-check')) majSelection();
    });
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.cmd-menu')) fermerMenus();
  });

  /* Formulaires à confirmer (synchronisation des suivis, suppression définitive). */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var question = form.getAttribute && form.getAttribute('data-confirmer');
    if (!question || form._confirme) return;
    e.preventDefault();
    confirmer(question).then(function (ok) {
      if (!ok) return;
      form._confirme = true;
      validerEnAttente().then(function () { form.submit(); });
    });
  }, true);

  /* Avant de suivre un lien de la page (autre file, fiche, pagination) :
     l'action en attente part d'abord. */
  document.addEventListener('click', function (e) {
    var lien = e.target.closest('a[href]');
    if (!lien || !enAttente || lien.target === '_blank' || e.defaultPrevented) return;
    if (lien.getAttribute('href').charAt(0) === '#' || /^(mailto|tel):/.test(lien.getAttribute('href'))) return;
    e.preventDefault();
    validerEnAttente().then(function () { window.location.href = lien.href; });
  });

  /* ─── Recherche : filtre immédiat dans la liste, Entrée = partout ────── */

  function filtrer() {
    var mots = rechercheEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var n = 0;
    toutesLignes().forEach(function (el) {
      if (el.classList.contains('is-sortie') || el.classList.contains('is-partie') || el.classList.contains('is-traitee')) return;
      var texte = el.getAttribute('data-recherche') || '';
      var ok = mots.every(function (m) { return texte.indexOf(m) !== -1; });
      el.hidden = !ok;
      if (ok) n += 1;
    });
    var aide = document.getElementById('cmdRechercheAide');
    if (aide) {
      aide.hidden = !mots.length;
      aide.textContent = n + ' commande' + (n > 1 ? 's' : '') + ' dans cette liste · Entrée pour chercher dans toutes les commandes';
    }
    majCompteLignes();
    majSelection();
    poserCurseur(0, false);
  }

  if (rechercheEl && lignesEl) {
    var valeurServeur = rechercheEl.value;
    rechercheEl.addEventListener('input', function () {
      /* La liste affichée vient déjà d'une recherche serveur : on ne refiltre
         que ce qu'on tape en plus. */
      if (valeurServeur && rechercheEl.value.indexOf(valeurServeur) === 0) return;
      valeurServeur = '';
      filtrer();
    });
  }
  if (rechercheEl && rechercheFormEl) {
    /* Entrée = chercher dans toutes les commandes. Le bouton d'envoi masqué
       du formulaire suffit en principe (envoi implicite) ; on ne dépend pas
       de cette règle du navigateur pour la fonction la plus utilisée. */
    rechercheEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      validerEnAttente().then(function () {
        if (typeof rechercheFormEl.requestSubmit === 'function') rechercheFormEl.requestSubmit();
        else rechercheFormEl.submit();
      });
    });
  }
  if (rechercheFormEl) {
    rechercheFormEl.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT') validerEnAttente().then(function () { rechercheFormEl.requestSubmit ? rechercheFormEl.requestSubmit() : rechercheFormEl.submit(); });
    });
    /* Les filtres vides ne partent pas dans l'adresse (…&status=&type=…). */
    var nettoyerFormulaire = function () {
      rechercheFormEl.querySelectorAll('input[name], select[name]').forEach(function (c) {
        if (c.type !== 'hidden' && !String(c.value || '').trim()) c.disabled = true;
      });
    };
    rechercheFormEl.addEventListener('submit', function (e) {
      if (!enAttente) { nettoyerFormulaire(); return; }
      e.preventDefault();
      validerEnAttente().then(function () { nettoyerFormulaire(); rechercheFormEl.submit(); });
    });
  }

  var filtresToggle = document.getElementById('cmdFiltresToggle');
  var filtresEl = document.getElementById('cmdFiltres');
  if (filtresToggle && filtresEl) {
    filtresToggle.addEventListener('click', function () {
      filtresEl.hidden = !filtresEl.hidden;
      filtresToggle.setAttribute('aria-expanded', filtresEl.hidden ? 'false' : 'true');
      ajusterCollants();
    });
  }

  /* ─── Clavier ─────────────────────────────────────────────────────────── */

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    var confirmation = document.getElementById('ajax-confirm-ok');
    if (confirmation && confirmation.offsetParent !== null) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) {
      if (e.key === 'Escape' && e.target.blur) e.target.blur();
      return;
    }
    if (vue !== 'active') return;

    if (e.key === '/') { e.preventDefault(); if (rechercheEl) rechercheEl.focus(); return; }
    if (e.key === 'Escape') {
      if (!document.querySelector('.cmd-menu-l:not([hidden])') && !fermerPanneau()) return;
      fermerMenus();
      return;
    }
    var panneauOuvert = panneauEl && !panneauEl.hidden;
    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (panneauOuvert) naviguerPanneau(1); else poserCurseur(curseur + 1, true);
      return;
    }
    if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (panneauOuvert) naviguerPanneau(-1); else poserCurseur(Math.max(0, curseur - 1), true);
      return;
    }
    if (e.key === 'Enter') {
      if (e.target && e.target.closest && e.target.closest('a, button')) return;
      var el = ligneCurseur();
      if (el) { e.preventDefault(); ouvrirPanneau(el); }
      return;
    }
    if (e.key === 'a' || e.key === 'A') {
      if (panneauOuvert && ouverte) {
        var p = donnees(ouverte);
        if (p.action && p.action.id) actionDepuisPanneau(p.action.id);
        else if (p.action && p.action.besoin === 'decision') actionDepuisPanneau('en_stock');
        else agir(ouverte);
        return;
      }
      var cible = ligneCurseur();
      if (cible) agir(cible);
    }
  });

  /* ─── En-têtes collants : décalages mesurés, pas supposés ─────────────── */

  function ajusterCollants() {
    var recherche = document.getElementById('cmdRecherche');
    var tete = document.querySelector('.cmd-tableau-tete');
    if (!recherche || !tete) return;
    var etroit = window.matchMedia('(max-width: 900px)').matches;
    var h1 = etroit ? 0 : recherche.offsetHeight;
    var h2 = h1 + (etroit ? 0 : tete.offsetHeight);
    page.style.setProperty('--cmd-sticky-titre', h1 + 'px');
    page.style.setProperty('--cmd-sticky-colonnes', h2 + 'px');
  }
  window.addEventListener('resize', ajusterCollants);
  ajusterCollants();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(ajusterCollants);

  majSelection();
  if (vue === 'active' && visibles().length) poserCurseur(0, false);
})();
