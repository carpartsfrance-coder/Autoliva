(function() {
  'use strict';
  var dialog = document.getElementById('procurementDialog');
  if (!dialog) return;
  var form = document.getElementById('procurementForm');
  var error = document.getElementById('procurementError');
  var feedback = document.getElementById('procurementFeedback');
  var save = document.getElementById('procurementSave');
  var lines = document.getElementById('procurementLines');
  var current = null, dirty = false, saving = false, opener = null, generation = 0;
  function node(tag, text, cls) { var el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  function showError(message) { error.textContent = message; error.hidden = !message; }
  function dateFR(value) { return value ? value.split('-').reverse().join('/') : ''; }
  function field(label, control) { var el=node('label',label); el.appendChild(control); return el; }
  function input(name, value, type, max) { var el=node('input'); el.name=name; el.type=type || 'text'; el.value=value || ''; if(max) el.maxLength=max; return el; }
  function paint(data) {
    current=data; dirty=false; lines.replaceChildren();
    document.getElementById('procurementTitle').textContent='Commande '+data.number+' · Pièces';
    document.getElementById('procurementSummary').textContent=data.summary.label+' · '+data.summary.next;
    data.lines.forEach(function(line) {
      var box=node('fieldset',undefined,'procurement-line'); box.dataset.index=line.index;
      box.appendChild(node('legend',line.quantity+' × '+line.name));
      box.appendChild(node('p','Réf. : '+(line.sku || 'non renseignée'),'procurement-help'));
      var grid=node('div',undefined,'procurement-fields');
      var select=node('select'); select.name='state';
      Object.entries(data.states).forEach(function(entry){var option=node('option',entry[1]);option.value=entry[0];select.appendChild(option);});select.value=line.state;
      grid.appendChild(field('Approvisionnement',select));grid.appendChild(field('Fournisseur',input('supplier',line.supplier,'text',160)));
      grid.appendChild(field('Commandée le',input('orderedOn',line.orderedOn,'date')));grid.appendChild(field('Réception prévue chez nous',input('expectedOn',line.expectedOn,'date')));
      box.appendChild(grid);
      var check=node('input');check.type='checkbox';check.dataset.incomingLine=line.index;check.disabled=line.state!=='ordered';
      box.appendChild(field('Inclure cette ligne dans le nouveau colis',check));
      box.appendChild(node('p','L’état s’applique aux '+line.quantity+' unité(s) de cette ligne. « Reçue » signifie que toute la quantité est arrivée.','procurement-help'));
      if(line.state==='ordered' && line.expectedOn && line.expectedOn<data.today)box.appendChild(node('p','Réception fournisseur en retard','procurement-warning'));
      var supplierDraft=node('button','Préparer un message fournisseur','btn btn-secondary');supplierDraft.type='button';
      supplierDraft.addEventListener('click',function(){
        document.getElementById('procurementDraftWrap').hidden=false;
        document.getElementById('procurementSubject').value='';
        document.getElementById('procurementMessage').value='Bonjour,\n\nPouvez-vous me confirmer la disponibilité et le délai pour '+line.quantity+' × '+line.name+(line.sku?' (réf. '+line.sku+')':'')+' ?\n\nMerci,\nAutoliva';
        document.getElementById('procurementMessage').focus();
      });box.appendChild(supplierDraft);
      lines.appendChild(box);
    });
    document.getElementById('incomingSave').disabled=data.readOnly;
    var parcels=document.getElementById('procurementParcels');parcels.replaceChildren();
    (data.parcels||[]).forEach(function(p){var row=node('div',undefined,'procurement-contact');var link=node('a',p.carrier.toUpperCase()+' · '+p.trackingNumber);link.href=p.url;link.target='_blank';link.rel='noopener noreferrer';row.appendChild(link);row.appendChild(node('p',p.supplier+' · '+({pending:'À synchroniser',info_received:'Étiquette créée',in_transit:'En transit',out_for_delivery:'En cours de livraison',delivered:'Livré par le transporteur · pièces à vérifier',exception:'Incident',unknown:'Statut inconnu'}[p.status]||'Inconnu')));if(p.syncError)row.appendChild(node('p',p.syncError,'procurement-warning'));if(p.stale)row.appendChild(node('p','La composition de la commande a changé depuis l’association. Vérifiez le contenu du colis.','procurement-warning'));parcels.appendChild(row);});
    if(!(data.parcels||[]).length)parcels.appendChild(node('p','Aucun colis fournisseur associé.','procurement-help'));
    form.elements.customerPromisedOn.value=data.customerPromisedOn;
    form.elements.contactOn.value=data.today; form.elements.contactNote.value='';
    var contacts=document.getElementById('procurementContacts');contacts.replaceChildren();
    if(data.contacts.length) contacts.appendChild(node('h4','Derniers contacts'));
    data.contacts.slice().reverse().forEach(function(contact){var row=node('div',undefined,'procurement-contact');row.appendChild(node('strong',dateFR(contact.on)+' · '+data.channels[contact.channel]+' · '+contact.author));row.appendChild(node('p',contact.note));contacts.appendChild(row);});
    form.querySelectorAll('fieldset,input[name],select[name],textarea[name]').forEach(function(el){el.disabled=data.readOnly;});
    save.disabled=data.readOnly; save.hidden=data.readOnly;
    if(data.readOnly) feedback.textContent='Commande en lecture seule.';
  }
  async function responseJSON(response) {
    var result;
    try { result=await response.json(); } catch(_){throw new Error('Session expirée ou réponse indisponible. Reconnectez-vous puis réessayez.');}
    if(!response.ok || !result.ok) throw new Error(result.error || 'Impossible d’enregistrer le suivi.');
    return result.data;
  }
  function close() {
    if(saving) return;
    if(dirty && !window.confirm('Fermer sans enregistrer vos changements ?'))return;
    generation++; dialog.close(); if(opener)opener.focus();
  }
  document.getElementById('procurementClose').addEventListener('click',close);
  dialog.addEventListener('cancel',function(event){event.preventDefault();close();});
  document.addEventListener('click',async function(event){
    var button=event.target.closest('[data-procurement-id]');if(!button)return;
    opener=button; current=null; dirty=false;document.getElementById('incomingNumber').value=''; feedback.textContent='';showError('');form.hidden=true;
    document.getElementById('procurementDraftWrap').hidden=true;document.getElementById('procurementCopy').textContent='Copier le message';
    document.getElementById('procurementTitle').textContent='Chargement du suivi…';document.getElementById('procurementSummary').textContent='';dialog.showModal();
    var token=++generation;
    try { var data=await responseJSON(await fetch('/admin/api/commandes/'+encodeURIComponent(button.dataset.procurementId)+'/approvisionnement',{credentials:'same-origin'}));if(token!==generation)return;paint(data);form.hidden=false;if(button.dataset.procurementFocus==='customer')form.elements.customerPromisedOn.focus(); } catch(err){if(token===generation)showError(err.message);}
  });
  form.addEventListener('input',function(event){if(event.target.name)dirty=true;});
  form.addEventListener('change',function(event){if(event.target.name)dirty=true;});
  form.addEventListener('submit',async function(event){
    event.preventDefault();if(!current || saving || current.readOnly)return;
    var body={revision:current.revision,signature:current.signature,customerPromisedOn:form.elements.customerPromisedOn.value,lines:[]};
    lines.querySelectorAll('fieldset').forEach(function(box){var line={index:Number(box.dataset.index)};box.querySelectorAll('input[name],select[name]').forEach(function(el){line[el.name]=el.value;});body.lines.push(line);});
    if(form.elements.contactNote.value.trim())body.contact={note:form.elements.contactNote.value,channel:form.elements.contactChannel.value,on:form.elements.contactOn.value};
    saving=true;save.disabled=true;save.textContent='Enregistrement…';showError('');feedback.textContent='';
    // Keep controls locked while the saved snapshot is in flight.
    form.querySelectorAll('input[name],select[name],textarea[name]').forEach(function(el){el.disabled=true;});
    try {
      var data=await responseJSON(await fetch('/admin/api/commandes/'+encodeURIComponent(current.id)+'/approvisionnement',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
      paint(data);feedback.textContent='Suivi enregistré.';document.dispatchEvent(new CustomEvent('procurement-saved',{detail:data}));
      document.querySelectorAll('[data-procurement-id]').forEach(function(button){if(button.dataset.procurementId===data.id){var summary=button.querySelector('[data-procurement-summary]');if(summary)summary.textContent=data.summary.label;var next=button.querySelector('[data-procurement-next]');if(next)next.textContent=data.summary.next;}});
      document.querySelectorAll('[data-procurement-contact]').forEach(function(el){if(el.dataset.procurementContact===data.id){var c=data.summary.lastContact;el.textContent=c?'Contact '+data.channels[c.channel]+' · '+dateFR(c.on):'';}});
      document.querySelectorAll('[data-procurement-alert]').forEach(function(el){if(el.dataset.procurementAlert===data.id)el.textContent=[data.summary.supplierLate?'Fournisseur en retard':'',data.summary.customerLate?'Date client dépassée':''].filter(Boolean).join(' · ');});
    } catch(err){showError(err.message);} finally {saving=false;save.disabled=!!current.readOnly;save.textContent='Enregistrer le suivi';form.querySelectorAll('input[name],select[name],textarea[name]').forEach(function(el){el.disabled=!!current.readOnly;});}
  });
  document.getElementById('incomingSave').addEventListener('click',async function(){
    if(!current||saving||current.readOnly)return;
    if(dirty){showError('Enregistrez les modifications des pièces avant d’associer le colis.');return;}
    var selected=Array.from(lines.querySelectorAll('[data-incoming-line]:checked')).map(el=>current.lines[Number(el.dataset.incomingLine)]);
    if(!selected.length){showError('Cochez au moins une ligne commandée à inclure dans le colis.');return;}
    var supplier=selected[0].supplier;
    if(!supplier||selected.some(l=>l.state!=='ordered'||l.supplier.trim().toLowerCase()!==supplier.trim().toLowerCase())){showError('Les pièces doivent être commandées auprès du même fournisseur.');return;}
    var button=this;button.disabled=true;saving=true;save.disabled=true;form.querySelectorAll('input[name],select[name],textarea[name]').forEach(el=>el.disabled=true);showError('');feedback.textContent='Association du colis…';
    try{
      await responseJSON(await fetch('/admin/api/colis-fournisseur',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({supplier:supplier,carrier:document.getElementById('incomingCarrier').value,trackingNumber:document.getElementById('incomingNumber').value,links:selected.map(l=>({orderId:current.id,itemIndex:l.index,signature:current.signature}))})}));
      var data=await responseJSON(await fetch('/admin/api/commandes/'+encodeURIComponent(current.id)+'/approvisionnement',{credentials:'same-origin'}));paint(data);document.getElementById('incomingNumber').value='';feedback.textContent='Colis associé. Le suivi est disponible dans cette commande.';document.dispatchEvent(new CustomEvent('procurement-saved',{detail:data}));
    }catch(err){showError(err.message);}finally{saving=false;button.disabled=!!current.readOnly;save.disabled=!!current.readOnly;form.querySelectorAll('input[name],select[name],textarea[name]').forEach(el=>el.disabled=!!current.readOnly);}
  });
  document.getElementById('procurementDraft').addEventListener('click',function(){
    if(!current)return;
    document.getElementById('procurementDraftWrap').hidden=false;
    var promised=form.elements.customerPromisedOn.value;
    document.getElementById('procurementSubject').value='Point sur votre commande '+current.number;
    document.getElementById('procurementMessage').value='Bonjour,\n\nNous vous informons d’un retard concernant votre commande '+current.number+'.'+(promised?' La livraison annoncée pour le '+dateFR(promised)+' doit être décalée.':'')+'\n\nNous faisons le point sur sa préparation et reviendrons vers vous avec une date confirmée. Nous vous présentons nos excuses pour ce délai.\n\nL’équipe Autoliva';
  });
  document.getElementById('procurementCopy').addEventListener('click',async function(){
    try{await navigator.clipboard.writeText((document.getElementById('procurementSubject').value?'Objet : '+document.getElementById('procurementSubject').value+'\n\n':'')+document.getElementById('procurementMessage').value);this.textContent='Message copié';}catch(_){showError('Copie indisponible : sélectionnez le texte du message pour le copier.');}
  });
  window.addEventListener('beforeunload',function(event){if(dirty){event.preventDefault();event.returnValue='';}});
})();
