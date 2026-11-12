/*
 * SAV — Dossier fournisseur (en anglais)
 * ---------------------------------------------------------------
 * Quand une pièce revient en SAV (mécatronique, boîte…), le fournisseur demande
 * toujours la même chose : les codes défaut (photo de la valise), le résultat du
 * réglage de base (réussi, ou son code d'erreur) et le contexte du montage.
 *
 * Ce service assemble ce dossier à partir du ticket :
 *   - checklist de ce qui manque (côté admin, en français) ;
 *   - message WhatsApp en anglais ;
 *   - PDF en anglais avec les photos, servi par un lien signé que le fournisseur
 *     peut ouvrir sans compte.
 *
 * Données personnelles : le dossier ne contient ni nom, ni e-mail, ni téléphone,
 * ni adresse du client. La facture du garage est exclue par défaut.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const brand = require('../config/brand');
const savFileStorage = require('./savFileStorage');

const ROLES = ['obd', 'reglage', 'autre', 'exclu'];

const DEFAULT_ROLE_BY_KIND = {
  photoObd: 'obd',
  confirmationReglageBase: 'reglage',
  photoPiece: 'autre',
  photoCompteur: 'autre',
};

const PIECE_EN = {
  mecatronique: 'DSG mechatronic unit',
  mecatronique_dq200: 'DQ200 mechatronic unit',
  mecatronique_dq250: 'DQ250 mechatronic unit',
  mecatronique_dq381: 'DQ381 mechatronic unit',
  mecatronique_dq500: 'DQ500 mechatronic unit',
  boite_vitesses: 'Gearbox',
  boite_transfert: 'Transfer case',
  pont: 'Axle / differential',
  differentiel: 'Differential',
  haldex: 'Haldex coupling',
  reducteur: 'Reduction gear',
  cardan: 'Drive shaft',
  arbre_transmission: 'Propeller shaft',
  visco_coupleur: 'Viscous coupling',
  moteur: 'Engine',
  turbo: 'Turbocharger',
  injecteur: 'Injector',
  autre: 'Part',
};

const MOMENT_EN = {
  au_montage: 'During installation',
  premier_demarrage: 'At first start',
  moins_100km: 'Less than 100 km after installation',
  '100_500km': '100 – 500 km after installation',
  '500_1000km': '500 – 1,000 km after installation',
  '1000_5000km': '1,000 – 5,000 km after installation',
  plus_5000km: 'More than 5,000 km after installation',
  inconnu: 'Unknown',
};

// Libellés des cases à cocher du formulaire SAV public (src/views/sav/index.ejs).
const SYMPTOM_EN = {
  'À-coups en passage de rapport': 'Jerky gear shifts',
  Patinage: 'Slipping',
  'Refus de passer une vitesse': 'Will not engage a gear',
  'Mode dégradé': 'Limp mode',
  'Voyant moteur': 'Warning light on',
  'Bruit anormal': 'Abnormal noise',
  "Fuite d'huile": 'Oil leak',
  Surchauffe: 'Overheating',
};

const REGLAGE_EN = { oui: 'Yes', non: 'No', inconnu: 'Unknown' };

// ---------------------------------------------------------------------------
// Signature du lien public
// ---------------------------------------------------------------------------

function secret() {
  const s = process.env.REPORT_SIGNATURE_SECRET || process.env.SAV_API_TOKEN || '';
  if (!s) throw new Error('REPORT_SIGNATURE_SECRET ou SAV_API_TOKEN requis pour signer le dossier fournisseur');
  return s;
}

function signature(numero) {
  return crypto.createHmac('sha256', secret()).update(`${numero}|dossier-fournisseur`).digest('hex').slice(0, 32);
}

function verifySignature(numero, h) {
  if (!numero || !h) return false;
  let expected;
  try { expected = signature(numero); } catch (_) { return false; }
  const a = Buffer.from(String(h));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pdfPath(numero) {
  return `/api/sav/dossier-fournisseur/${encodeURIComponent(numero)}.pdf?h=${signature(numero)}`;
}

// ---------------------------------------------------------------------------
// Fichiers du ticket et rôle dans le dossier
// ---------------------------------------------------------------------------

function isImageMime(mime) {
  return /^image\//i.test(String(mime || ''));
}

// Tous les fichiers du ticket, y compris les anciens champs `documents.*`
// antérieurs à `documentsList`.
function ticketFiles(ticket) {
  const out = [];
  const seen = new Set();
  function add(url, kind, extra) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(Object.assign({ url, kind: kind || 'autre', originalName: '', mime: '' }, extra || {}));
  }
  (ticket.documentsList || []).forEach((d) => {
    if (d && d.url) add(d.url, d.kind, { originalName: d.originalName || '', mime: d.mime || '' });
  });
  const docs = ticket.documents || {};
  (docs.photosObd || []).forEach((u) => add(u, 'photoObd'));
  add(docs.confirmationReglageBase, 'confirmationReglageBase');
  add(docs.photoCompteur, 'photoCompteur');
  (docs.photosVisuelles || []).forEach((u) => add(u, 'photoPiece'));
  add(docs.factureMontage, 'factureMontage');
  return out;
}

function filesWithRoles(ticket) {
  const saved = new Map();
  (((ticket.fournisseur || {}).photosDossier) || []).forEach((p) => {
    if (p && p.url && ROLES.includes(p.role)) saved.set(p.url, p.role);
  });
  return ticketFiles(ticket).map((f) => Object.assign(f, {
    role: saved.get(f.url) || DEFAULT_ROLE_BY_KIND[f.kind] || 'exclu',
    isImage: isImageMime(f.mime),
  }));
}

// ---------------------------------------------------------------------------
// Noms de fichiers et libellés : dans un groupe WhatsApp chargé, chaque fichier
// doit dire seul de quel dossier il vient et ce qu'il montre.
// ---------------------------------------------------------------------------

const PART_SHORT = {
  mecatronique: 'MECHATRONIC',
  mecatronique_dq200: 'DQ200',
  mecatronique_dq250: 'DQ250',
  mecatronique_dq381: 'DQ381',
  mecatronique_dq500: 'DQ500',
  boite_vitesses: 'GEARBOX',
  boite_transfert: 'TRANSFER-CASE',
  pont: 'AXLE',
  differentiel: 'DIFFERENTIAL',
  haldex: 'HALDEX',
  reducteur: 'REDUCTION-GEAR',
  cardan: 'DRIVESHAFT',
  arbre_transmission: 'PROPSHAFT',
  visco_coupleur: 'VISCOUS-COUPLING',
  moteur: 'ENGINE',
  turbo: 'TURBO',
  injecteur: 'INJECTOR',
};

// Code court de la pièce : le code boîte s'il est connu (DQ200, DL501…), trouvé dans
// le type, la référence ou l'article commandé, sinon le type de pièce en anglais.
function partCode(ticket, order) {
  const sources = [ticket.pieceType, ticket.referencePiece]
    .concat(order && Array.isArray(order.items) ? order.items.map((it) => `${it.name || ''} ${it.sku || ''}`) : []);
  for (const src of sources) {
    const m = String(src || '').match(/\b(DQ\d{3}|DL\d{3}|DQ\d{3}-\d)\b/i);
    if (m) return m[1].toUpperCase();
  }
  return PART_SHORT[ticket.pieceType] || 'PART';
}

const ROLE_FILE = {
  obd: { slug: 'fault-codes', label: 'Fault codes' },
  reglage: { slug: 'basic-settings', label: 'Basic settings' },
  autre: { slug: 'photo', label: 'Photo' },
  exclu: { slug: 'document', label: 'Document' },
};

function extensionOf(file) {
  const mime = String(file.mime || '').toLowerCase();
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  const m = String(file.originalName || '').match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : 'bin';
}

// Noms et libellés pour le PDF et chaque fichier, numérotés dans l'ordre du dossier
// (codes défaut, réglage de base, autres photos, puis fichiers non envoyés).
function fileNaming(ticket, order) {
  const code = partCode(ticket, order);
  const base = `${String(ticket.numero || 'SAV').replace(/[^A-Za-z0-9-]/g, '')}_${code}`;
  const order_ = ['obd', 'reglage', 'autre', 'exclu'];
  const files = filesWithRoles(ticket).slice().sort((a, b) => order_.indexOf(a.role) - order_.indexOf(b.role));
  const byUrl = {};
  files.forEach((f, i) => {
    const r = ROLE_FILE[f.role] || ROLE_FILE.autre;
    byUrl[f.url] = {
      fileName: `${base}_${i + 1}-${r.slug}.${extensionOf(f)}`,
      label: `${ticket.numero} · ${code} · ${r.label}`,
    };
  });
  return { partCode: code, pdfFileName: `${base}_claim.pdf`, files: byUrl };
}

// ---------------------------------------------------------------------------
// Contenu
// ---------------------------------------------------------------------------

function clean(text) {
  return String(text == null ? '' : text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function fmtDateEn(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtKm(km) {
  const n = Number(km);
  return Number.isFinite(n) && n > 0 ? `${n.toLocaleString('en-GB')} km` : '';
}

// Le préfixe de version invalide les traductions faites avant le retrait des
// données personnelles (elles contenaient la signature du client).
function descriptionHash(text) {
  return crypto.createHash('sha1').update(`v2|${clean(text)}`).digest('hex');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// La description est un texte libre : les clients la signent souvent (nom,
// téléphone, e-mail). Rien de cela ne doit partir chez le fournisseur.
function scrubPersonal(text, ticket) {
  let out = String(text || '');
  const c = (ticket && ticket.client) || {};
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '');
  // Téléphones : français (06 12 34 56 78, +33 6…, 0033…) et internationaux (+34 612…).
  out = out.replace(/(?<![\w+])(?:(?:\+|00)33[\s.-]?(?:\(0\)[\s.-]?)?|0)[1-9](?:[\s.-]?\d{2}){4}(?!\d)/g, '');
  out = out.replace(/(?<![\w+])\+\d{2,3}(?:[\s.-]?\d{2,4}){3,5}(?!\d)/g, '');
  const known = [c.telephone].filter(Boolean).map((t) => String(t).trim()).filter((t) => t.length >= 6);
  known.forEach((t) => { out = out.split(t).join(''); });
  const names = [c.nom, c.prenom].filter(Boolean).join(' ').split(/\s+/).filter((w) => w.length >= 3);
  names.forEach((w) => {
    out = out.replace(new RegExp(`(?<![\\p{L}])${escapeRegex(w)}(?![\\p{L}])`, 'giu'), '');
  });
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// Faits du dossier, en anglais, partagés par le message et le PDF.
function summary(ticket, order, descriptionEn) {
  const v = ticket.vehicule || {};
  const m = ticket.montage || {};
  const d = ticket.diagnostic || {};
  const f = ticket.fournisseur || {};
  const rawDescription = clean(d.description);
  const translated = scrubPersonal(descriptionEn
    || (f.descriptionEn && f.descriptionEnSource === descriptionHash(rawDescription) ? f.descriptionEn : ''), ticket);
  const items = order && Array.isArray(order.items)
    ? order.items.map((it) => clean([it.name, it.sku ? `(${it.sku})` : ''].filter(Boolean).join(' '))).filter(Boolean)
    : [];
  const oil = [clean(m.huileType), m.huileQuantite ? `${clean(m.huileQuantite)} L` : ''].filter(Boolean).join(', ');
  return {
    numero: ticket.numero,
    orderNumber: clean(ticket.numeroCommande),
    orderDate: order ? fmtDateEn(order.createdAt) : '',
    orderedItems: items,
    partType: PIECE_EN[ticket.pieceType] || clean(ticket.pieceType) || 'Part',
    partReference: clean(ticket.referencePiece),
    serialNumber: clean(ticket.numeroSerie),
    vehicle: [v.marque, v.modele, v.motorisation, v.annee].map(clean).filter(Boolean).join(' '),
    vin: clean(v.vin),
    mileage: fmtKm(v.kilometrage),
    installDate: fmtDateEn(m.date),
    basicSettingsDone: REGLAGE_EN[m.reglageBase] || '',
    oil,
    failureWhen: MOMENT_EN[m.momentPanne] || clean(m.momentPanne),
    symptoms: (d.symptomes || []).map((s) => SYMPTOM_EN[s] || clean(s)).filter(Boolean),
    faultCodes: (d.codesDefaut || []).map(clean).filter(Boolean),
    description: translated || scrubPersonal(rawDescription, ticket),
    descriptionIsTranslated: !!translated,
  };
}

// Ce que le fournisseur réclame, vérifié côté admin (en français).
function checklist(ticket) {
  const v = ticket.vehicule || {};
  const m = ticket.montage || {};
  const d = ticket.diagnostic || {};
  const files = filesWithRoles(ticket);
  const reglageLabel = { oui: 'oui', non: 'non', inconnu: 'ne sait pas' }[m.reglageBase] || 'non renseigné';
  const items = [
    { key: 'commande', label: 'N° de commande', ok: !!ticket.numeroCommande, value: ticket.numeroCommande || '' },
    { key: 'vin', label: 'VIN', ok: !!v.vin, value: v.vin || '' },
    { key: 'km', label: 'Kilométrage', ok: Number(v.kilometrage) > 0, value: v.kilometrage ? String(v.kilometrage) : '' },
    { key: 'montage', label: 'Date de montage', ok: !!m.date, value: m.date ? new Date(m.date).toLocaleDateString('fr-FR') : '' },
    { key: 'reglageFait', label: 'Réglage de base fait', ok: m.reglageBase === 'oui', value: reglageLabel },
    { key: 'codes', label: 'Codes défaut saisis', ok: (d.codesDefaut || []).length > 0, value: (d.codesDefaut || []).join(', '), optional: true },
    { key: 'photoObd', label: 'Photo des codes défaut (valise)', ok: files.some((f) => f.role === 'obd'), photo: true },
    { key: 'photoReglage', label: 'Photo du résultat du réglage de base', ok: files.some((f) => f.role === 'reglage'), photo: true },
  ];
  return items;
}

// Texte à proposer au client quand des photos manquent (vide si rien ne manque).
function clientRequestText(ticket) {
  const list = checklist(ticket);
  const lines = [];
  if (!list.find((i) => i.key === 'photoObd').ok) {
    lines.push('- une photo de l\'écran de la valise de diagnostic montrant les codes défaut ;');
  }
  if (!list.find((i) => i.key === 'photoReglage').ok) {
    lines.push('- une photo de l\'écran du réglage de base (adaptation) montrant son résultat : réussi, ou le code d\'erreur s\'il a échoué.');
  }
  if (!lines.length) return '';
  return [
    'Bonjour {client_prenom},',
    '',
    'Pour faire avancer votre dossier {ticket_numero} auprès de notre fournisseur, merci de nous envoyer en réponse à ce message :',
    ...lines,
    '',
    'Ces éléments sont indispensables à l\'analyse de la garantie.',
    '',
    'Merci d\'avance,',
    'L\'équipe SAV',
  ].join('\n');
}

function buildMessageEn(ticket, order, link) {
  const s = summary(ticket, order);
  const lines = [];
  lines.push('Hello,');
  lines.push('');
  lines.push(`Warranty claim *${s.numero}* – ${brand.NAME}`);
  lines.push(`Part: ${s.partType}${s.orderNumber ? ` (order ${s.orderNumber}${s.orderDate ? `, ${s.orderDate}` : ''})` : ''}`);
  if (s.orderedItems.length) lines.push(`Item: ${s.orderedItems.join(' / ')}`);
  if (s.partReference) lines.push(`Part reference: ${s.partReference}`);
  const vehicle = [s.vehicle, s.vin ? `VIN ${s.vin}` : '', s.mileage].filter(Boolean).join(' – ');
  if (vehicle) lines.push(`Vehicle: ${vehicle}`);
  const install = [s.installDate ? `Installed on ${s.installDate}` : '', s.basicSettingsDone ? `basic settings done: ${s.basicSettingsDone}` : ''].filter(Boolean).join(' – ');
  if (install) lines.push(install);
  if (s.failureWhen) lines.push(`Problem appeared: ${s.failureWhen}`);
  if (s.symptoms.length) lines.push(`Symptoms: ${s.symptoms.join(', ')}`);
  lines.push(`Fault codes: ${s.faultCodes.length ? s.faultCodes.join(', ') : 'see photo in the file'}`);
  if (link) {
    lines.push('');
    lines.push(`Full file with photos (fault codes, basic settings result): ${link}`);
  }
  lines.push('');
  lines.push('Could you please check it and tell us how you would like to proceed?');
  lines.push('Thank you.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Traduction de la description client (OpenAI, facultative)
// ---------------------------------------------------------------------------

async function translateToEnglish(text, ticket) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  // Les données personnelles sont retirées AVANT l'envoi à la traduction.
  const source = scrubPersonal(clean(text), ticket).slice(0, 4000);
  if (!apiKey || !source) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: (process.env.OPENAI_SAV_REFORMULATE_MODEL || '').trim() || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 1500,
        messages: [
          {
            role: 'system',
            content: 'Translate the French text written by a customer about a faulty car part into clear, plain English for a parts supplier. Keep fault codes, part numbers, order numbers, dates and figures exactly as written. Leave out the customer\'s signature, name, phone number, e-mail and postal address. Output only the translation, without any comment.',
          },
          { role: 'user', content: source },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const out = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return typeof out === 'string' && out.trim() ? out.trim() : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Traduit et mémorise sur le ticket (document Mongoose) si la description a changé.
// Retourne true si le ticket a été modifié (à sauvegarder par l'appelant).
async function ensureTranslation(ticket) {
  const raw = clean(ticket.diagnostic && ticket.diagnostic.description);
  if (!raw) return false;
  const hash = descriptionHash(raw);
  const f = ticket.fournisseur || {};
  if (f.descriptionEn && f.descriptionEnSource === hash) return false;
  const translated = await translateToEnglish(raw, ticket);
  if (!translated) return false;
  ticket.fournisseur = ticket.fournisseur || {};
  ticket.fournisseur.descriptionEn = translated;
  ticket.fournisseur.descriptionEnSource = hash;
  return true;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  return null;
}

// Les polices standard du PDF ne couvrent que le latin : on retire le reste (emojis…).
function pdfText(text) {
  return clean(text).replace(/[^\n\t\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, '');
}

async function buildPdf(ticket, order, opts) {
  const baseUrl = (opts && opts.baseUrl) || '';
  const s = summary(ticket, order);
  const naming = fileNaming(ticket, order);
  const files = filesWithRoles(ticket).filter((f) => f.role !== 'exclu');
  const token = signature(ticket.numero);

  // Lecture des fichiers avant de composer le document (pdfkit est synchrone).
  const loaded = [];
  for (const f of files) {
    const id = savFileStorage.extractIdFromUrl(f.url);
    let buffer = null;
    if (id) {
      try { buffer = await savFileStorage.readBuffer(id); } catch (_) { buffer = null; }
    }
    const link = id ? `${baseUrl}/sav-files/${id}?fk=${token}` : (/^https?:\/\//.test(f.url) ? f.url : '');
    loaded.push(Object.assign({}, f, { buffer, format: sniffImage(buffer), link }));
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: `Warranty claim ${s.numero}`, Author: brand.NAME },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    doc.fillColor('#ec1313').font('Helvetica-Bold').fontSize(18).text(pdfText(brand.NAME));
    doc.moveDown(0.3);
    doc.fillColor('#0f172a').fontSize(15).text(`Warranty claim – ${pdfText(s.numero)} · ${pdfText(naming.partCode)}`);
    doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(`Issued on ${fmtDateEn(new Date())}`);
    doc.moveDown(0.8);

    // `keep` : place à garder sous le titre pour ne pas le laisser seul en bas de page.
    function section(title, keep) {
      if (doc.y + 30 + (keep || 30) > bottom()) doc.addPage();
      doc.moveDown(0.4);
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), left, doc.y, { width });
      const y = doc.y + 2;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
      doc.moveDown(0.5);
    }

    function row(label, value) {
      const text = pdfText(value);
      if (!text) return;
      doc.font('Helvetica').fontSize(10);
      const labelWidth = 150;
      const h = Math.max(doc.heightOfString(text, { width: width - labelWidth }), 12);
      if (doc.y + h > bottom()) doc.addPage();
      const y = doc.y;
      doc.fillColor('#64748b').font('Helvetica').text(label, left, y, { width: labelWidth - 10 });
      doc.fillColor('#0f172a').font('Helvetica').text(text, left + labelWidth, y, { width: width - labelWidth });
      doc.x = left;
      doc.y = y + h + 4;
    }

    section('Order and part');
    row('Claim reference', s.numero);
    row('Order number', s.orderNumber);
    row('Order date', s.orderDate);
    row('Ordered item', s.orderedItems.join('\n'));
    row('Part type', s.partType);
    row('Part reference', s.partReference);
    row('Serial number', s.serialNumber);

    section('Vehicle');
    row('Vehicle', s.vehicle);
    row('VIN', s.vin);
    row('Mileage', s.mileage);

    section('Installation');
    row('Installation date', s.installDate);
    row('Basic settings performed', s.basicSettingsDone);
    row('Oil used', s.oil);
    row('Problem appeared', s.failureWhen);

    section('Fault');
    row('Symptoms', s.symptoms.join(', '));
    row('Fault codes', s.faultCodes.length ? s.faultCodes.join(', ') : 'See photo below');
    row(s.descriptionIsTranslated ? 'Customer description (translated from French)' : 'Customer description (French)', s.description);

    const groups = [
      { role: 'obd', title: 'Fault codes – diagnostic tool screen' },
      { role: 'reglage', title: 'Basic settings result' },
      { role: 'autre', title: 'Other photos' },
    ];
    // Hauteur d'affichage d'une image (null si le fichier n'est pas une image lisible).
    function imageBox(f) {
      if (!f.format) return null;
      try {
        const img = doc.openImage(f.buffer);
        // Orientation EXIF 5 à 8 : pdfkit fait pivoter l'image, largeur et hauteur s'échangent.
        const rotated = img.orientation > 4;
        const iw = rotated ? img.height : img.width;
        const ih = rotated ? img.width : img.height;
        return { img, h: ih * Math.min(width / iw, 340 / ih, 1) };
      } catch (_) {
        return null;
      }
    }

    groups.forEach((g) => {
      const list = loaded.filter((f) => f.role === g.role);
      list.forEach((f) => { f.box = imageBox(f); });
      // Place gardée sous le titre : légende (~16 pt) + première image.
      section(g.title, list.length && list[0].box ? list[0].box.h + 20 : 30);
      if (!list.length) {
        doc.fillColor('#b45309').font('Helvetica-Oblique').fontSize(10).text('Not provided yet.', left, doc.y, { width });
        doc.moveDown(0.3);
        return;
      }
      list.forEach((f) => {
        const named = naming.files[f.url] || {};
        if (f.box) {
          if (doc.y + f.box.h + 16 > bottom()) doc.addPage();
          // Même libellé que le bandeau des photos partagées, pour s'y retrouver.
          doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(pdfText(named.label || ''), left, doc.y, { width });
          doc.moveDown(0.2);
          doc.image(f.box.img, left, doc.y, { fit: [width, f.box.h], align: 'center' });
          doc.y += f.box.h + 10;
        } else {
          if (doc.y + 16 > bottom()) doc.addPage();
          const name = pdfText(named.fileName || f.originalName) || 'file';
          if (f.link) {
            doc.fillColor('#2563eb').font('Helvetica').fontSize(10)
              .text(`Open attached file: ${name}`, left, doc.y, { width, link: f.link, underline: true });
          } else {
            doc.fillColor('#64748b').font('Helvetica').fontSize(10).text(`Attached file not available: ${name}`, left, doc.y, { width });
          }
          doc.moveDown(0.4);
        }
      });
    });

    doc.end();
  });
}

// Autorise l'accès public à un fichier du ticket via le jeton du dossier, uniquement
// s'il fait partie du dossier envoyé (jamais un fichier exclu, comme la facture).
function fileSharedWithSupplier(ticket, fileId, token) {
  if (!ticket || !verifySignature(ticket.numero, token)) return false;
  return filesWithRoles(ticket).some((f) => f.role !== 'exclu' && savFileStorage.extractIdFromUrl(f.url) === String(fileId));
}

module.exports = {
  ROLES,
  partCode,
  fileNaming,
  scrubPersonal,
  signature,
  verifySignature,
  pdfPath,
  filesWithRoles,
  checklist,
  clientRequestText,
  summary,
  buildMessageEn,
  ensureTranslation,
  buildPdf,
  fileSharedWithSupplier,
};
