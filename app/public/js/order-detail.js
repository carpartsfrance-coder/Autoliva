(function () {
  'use strict';
  if (!document.querySelector('.order-detail')) return;
  function revealAnchor() {
    var id = location.hash.slice(1);
    if (!id) return;
    var target = document.getElementById(id);
    if (!target) return;
    if (target.tagName === 'DETAILS') target.open = true;
    var parent = target.parentElement;
    while (parent) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
  }
  window.addEventListener('hashchange', revealAnchor);
  document.querySelectorAll('.detail-navigation a').forEach(function(a) {
    a.addEventListener('click', function() { var target=document.getElementById(a.hash.slice(1)); if(target && target.tagName==='DETAILS') target.open=true; });
  });
  revealAnchor();
  document.addEventListener('click', function(e) {
    document.querySelectorAll('.detail-more[open]').forEach(function(el) { if(!el.contains(e.target)) el.open=false; });
  });
  function text(id, value) { var el=document.getElementById(id); if(el) el.textContent=value; }
  function node(tag,value) { var el=document.createElement(tag); el.textContent=value; return el; }
  var parcelLabels={pending:'À synchroniser',info_received:'Étiquette créée',in_transit:'En transit',out_for_delivery:'En cours de livraison',delivered:'Livré par le transporteur · pièces à vérifier',exception:'Incident transporteur',unknown:'Suivi indisponible'};
  document.addEventListener('procurement-saved', function(event) {
    var data=event.detail;
    if(!data) return;
    text('detail-next',data.summary.next);
    text('detail-promised',data.customerPromisedOn ? data.customerPromisedOn.split('-').reverse().join('/') : 'À renseigner');
    data.lines.forEach(function(line) {
      var row=document.querySelector('[data-detail-line="'+line.index+'"]'); if(!row) return;
      row.querySelector('[data-line-state]').textContent=data.states[line.state];
      row.querySelector('[data-line-supplier]').textContent=line.supplier||'Fournisseur non renseigné';
      row.querySelector('[data-line-date]').textContent=line.state==='ordered'&&line.expectedOn?'Réception prévue : '+line.expectedOn.split('-').reverse().join('/'):'';
    });
    var list=document.getElementById('detail-parcels'); if(!list) return;
    list.replaceChildren();
    if(!data.parcels.length)list.appendChild(node('p','Aucun colis fournisseur enregistré.'));
    data.parcels.forEach(function(p) {
      var row=node('article',''); row.appendChild(node('strong',p.supplier));
      var link=node('a',p.carrier.toUpperCase()+' · '+p.trackingNumber+' ↗');link.href=p.url;link.target='_blank';link.rel='noopener';row.appendChild(link);
      row.appendChild(node('span',parcelLabels[p.status]||'Suivi indisponible'));
      if(p.stale)row.appendChild(node('span','Composition modifiée : vérifier les pièces associées.'));
      if(p.syncError)row.appendChild(node('span',p.syncError));
      row.appendChild(node('small','Vérifié : '+(p.lastCheckedAt?new Date(p.lastCheckedAt).toLocaleString('fr-FR',{timeZone:'Europe/Paris'}):'jamais')));list.appendChild(row);
    });
  });
})();
