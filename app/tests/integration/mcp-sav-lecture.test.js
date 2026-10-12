/**
 * Connecteur MCP — outils SAV et commandes en LECTURE SEULE
 * (listSavTickets, getSavTicket, getSavAttachment, getOrder).
 *
 * Vérifie ce que le connecteur rend, ce qu'il refuse de rendre (fichiers d'un
 * autre ticket, fichiers internes, téléphones, adresses, fichiers de commande),
 * qu'un fichier piégé ne coûte rien au serveur et qu'aucun appel n'écrit en base.
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { PDFDocument } = require('pdf-lib');
const { Jimp } = require('jimp');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
process.env.MCP_BEARER_TOKEN = 'jeton-de-test-mcp-sav';
process.env.SAV_AGENT_API_KEY = 'cle-agent-de-test';

const JOUR = 24 * 3600 * 1000;
const ilYa = (jours) => new Date(Date.now() - jours * JOUR);

const TELEPHONE = '0611223344';
const TELEPHONE_SMS = '0755443322';
const RUE = '12 rue des Lilas';

let serveur;

async function appel(dispatch, name, args) {
  const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } });
  assert.ok(r.result, `réponse JSON-RPC attendue pour ${name}`);
  return r.result;
}
const texte = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (res) => JSON.parse(res.content[0].text);
const images = (res) => res.content.filter((c) => c.type === 'image');

/* Copie dans un tableau neuf : pdf-lib lit mal un petit Buffer pris dans la réserve partagée de Node. */
async function jpeg(largeur, hauteur, couleur) {
  return Buffer.from(Uint8Array.from(await new Jimp({ width: largeur, height: hauteur, color: couleur }).getBuffer('image/jpeg', { quality: 80 })));
}

/* Photo « de téléphone » : du bruit, donc lourde (plusieurs Mo) — elle doit être réduite. */
async function photoLourde(largeur, hauteur) {
  const img = new Jimp({ width: largeur, height: hauteur, color: 0xffffffff });
  crypto.randomFillSync(img.bitmap.data);
  for (let i = 3; i < img.bitmap.data.length; i += 4) img.bitmap.data[i] = 255;
  return img.getBuffer('image/png');
}

/* PNG piégé : 600 octets qui annoncent 12 000 × 12 000 px (576 Mo une fois décodé). */
function pngPiege() {
  const b = Buffer.alloc(600);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(12000, 16);
  b.writeUInt32BE(12000, 20);
  b[24] = 8; b[25] = 6;
  return b;
}

test('connecteur MCP — SAV et commandes en lecture seule', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => {
    await mongoose.disconnect();
    await serveur.stop();
  });

  const SavTicket = require('../../src/models/SavTicket');
  const Order = require('../../src/models/Order');
  const storage = require('../../src/services/savFileStorage');
  const { dispatch, mountMcp } = require('../../src/mcp/server');

  /* ── Fichiers ────────────────────────────────────────────────────────── */
  const T1 = { ticketNumero: 'SAV-2026-0901', kind: 'client_upload', uploadedBy: 'client' };
  const depot = (buffer, nom, mime, metadata) => storage.saveBuffer({ buffer, filename: nom, mime, metadata: { ...metadata, originalName: nom } });

  const capture = await depot(await new Jimp({ width: 2400, height: 1200, color: 0x3366ccff }).getBuffer('image/png'), 'capture.png', 'image/png', T1);
  const photo = await depot(await photoLourde(2000, 1500), 'compteur.png', 'image/png', T1);
  const jpegNommePng = await depot(await jpeg(800, 600, 0x448844ff), 'photo.png', 'image/png', T1);
  const piege = await depot(pngPiege(), 'piege.png', 'image/png', T1);

  const scan = await PDFDocument.create();
  for (const couleur of [0xcc3333ff, 0x33cc33ff, 0x3333ccff, 0xcccc33ff]) {
    const img = await scan.embedJpg(await jpeg(1000, 1400, couleur));
    scan.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  }
  const pdfScanne = await depot(Buffer.from(await scan.save({ useObjectStreams: false })), 'releve-defauts.pdf', 'application/pdf', T1);

  const texteDoc = await PDFDocument.create();
  texteDoc.addPage([595, 842]).drawText('Devis garage 1 059,10 EUR', { x: 50, y: 700, size: 14 });
  const pdfTexte = await depot(Buffer.from(await texteDoc.save({ useObjectStreams: false })), 'devis.pdf', 'application/pdf', T1);

  // Facture « texte » avec un logo : le logo n'est pas une page.
  const logoDoc = await PDFDocument.create();
  const logo = await logoDoc.embedJpg(await jpeg(600, 320, 0xee8800ff));
  const pageLogo = logoDoc.addPage([595, 842]);
  pageLogo.drawImage(logo, { x: 40, y: 760, width: 120, height: 64 });
  pageLogo.drawText('Facture de montage — total 667,45 CHF', { x: 50, y: 700, size: 12 });
  const pdfLogo = await depot(Buffer.from(await logoDoc.save()), 'facture.pdf', 'application/pdf', T1);

  // PDF mixte : une page scannée puis une page de texte.
  const mixte = await PDFDocument.create();
  const pageScan = await mixte.embedJpg(await jpeg(1200, 1700, 0x777777ff));
  mixte.addPage([595, 842]).drawImage(pageScan, { x: 0, y: 0, width: 595, height: 842 });
  mixte.addPage([595, 842]).drawText('Conditions générales', { x: 50, y: 700, size: 12 });
  const pdfMixte = await depot(Buffer.from(await mixte.save({ useObjectStreams: false })), 'mixte.pdf', 'application/pdf', T1);
  // Le même, enregistré comme le font la plupart des logiciels : objets compressés.
  const pdfMixteCompresse = await depot(Buffer.from(await mixte.save()), 'mixte-compresse.pdf', 'application/pdf', T1);

  const fichierAutreTicket = await depot(await jpeg(800, 600, 0x999999ff), 'autre.jpg', 'image/jpeg', { ticketNumero: 'SAV-2026-0902', kind: 'client_upload', uploadedBy: 'client' });
  const fichierInterne = await depot(await jpeg(800, 600, 0x111111ff), 'procedure.jpg', 'image/jpeg', { kind: 'procedure', uploadedBy: 'admin' });

  /* ── Tickets ─────────────────────────────────────────────────────────── */
  async function ticket(donnees) {
    const doc = new SavTicket(donnees);
    assert.ifError(doc.validateSync());
    const brut = doc.toObject();
    brut.createdAt = donnees.createdAt;
    brut.updatedAt = donnees.updatedAt || donnees.createdAt;
    await SavTicket.collection.insertOne(brut);
  }

  const longMessage = 'x'.repeat(9000);
  await ticket({
    numero: 'SAV-2026-0901', motifSav: 'piece_defectueuse', statut: 'pre_qualification',
    numeroCommande: 'CP2026-900001', numeroSerie: 'TCU-2025-11-03',
    client: { nom: 'Valérie Sorel', email: 'valerie.sorel@example.com', telephone: TELEPHONE, adresse: RUE, type: 'B2C' },
    vehicule: { marque: 'VW', modele: 'Polo', annee: 2015, kilometrage: 127822 },
    garage: { nom: 'Garage du Centre', telephone: '0388000000' },
    diagnostic: { description: 'Boîte en mode dégradé', symptomes: ['Mode dégradé'], codesDefaut: ['P0607'] },
    montage: { date: ilYa(95), reglageBase: 'oui', momentPanne: '100-500km' },
    documentsList: [{ kind: 'factureMontage', url: pdfTexte.url, originalName: 'devis.pdf', mime: 'application/pdf', size: 1200 }],
    documents: { photosObd: [pdfScanne.url] },
    sla: { dateOuverture: ilYa(80), dateLimite: ilYa(73) },
    messages: [
      { date: ilYa(80), auteur: 'client', canal: 'inapp', contenu: 'La boîte se met en défaut.', attachments: [{ url: capture.url, originalName: 'capture.png', size: 5000, mime: 'image/png', kind: 'client_upload' }] },
      { date: ilYa(70), auteur: 'Agent SAV', canal: 'inapp', contenu: 'Merci de nous envoyer le relevé.' },
      { date: ilYa(69), auteur: 'Agent SAV', canal: 'interne', contenu: 'Dossier fournisseur envoyé.' },
      { date: ilYa(10), auteur: 'client', canal: 'email', contenu: longMessage },
      { date: ilYa(3), auteur: 'client', canal: 'inapp', contenu: 'Toujours sans nouvelles.' },
    ],
    lastClientMessageAt: ilYa(3), lastAdminMessageAt: ilYa(70),
    createdAt: ilYa(80),
  });
  await ticket({
    numero: 'SAV-2026-0902', motifSav: 'retard_livraison', statut: 'enquete_transporteur',
    numeroCommande: 'CP2026-900002',
    client: { nom: 'Bruno Kerlan', email: 'bruno.kerlan@example.com', telephone: '0699887766' }, // type non résolu
    sla: { dateOuverture: ilYa(2), dateLimite: new Date(Date.now() + 5 * JOUR) },
    messages: [
      { date: ilYa(2), auteur: 'client', canal: 'inapp', contenu: 'Où est mon colis ?' },
      { date: ilYa(1), auteur: 'Agent SAV', canal: 'inapp', contenu: 'Il part demain.' },
    ],
    lastClientMessageAt: ilYa(2), lastAdminMessageAt: ilYa(1),
    createdAt: ilYa(2),
  });
  await ticket({
    numero: 'SAV-2026-0903', motifSav: 'piece_defectueuse', statut: 'clos',
    client: { nom: 'Claire Dumas', email: 'claire.dumas@example.com', type: 'B2B' },
    sla: { dateOuverture: ilYa(200), dateLimite: ilYa(190) },
    messages: [{ date: ilYa(200), auteur: 'client', canal: 'inapp', contenu: 'Résolu.' }],
    lastClientMessageAt: ilYa(200),
    createdAt: ilYa(200),
  });
  // Ticket créé depuis le back-office : aucun message. Il nous attend aussi.
  await ticket({
    numero: 'SAV-2026-0904', motifSav: 'autre', statut: 'ouvert',
    client: { nom: 'Denis Morvan', email: 'denis.morvan@example.com', type: 'B2C' },
    sla: { dateOuverture: ilYa(1), dateLimite: new Date(Date.now() + 9 * JOUR) },
    messages: [],
    createdAt: ilYa(1),
  });

  /* ── Commande ────────────────────────────────────────────────────────── */
  const adresse = { fullName: 'Valérie Sorel', phone: TELEPHONE, line1: RUE, postalCode: '67000', city: 'Strasbourg', country: 'France' };
  const SECRET = Buffer.from('%PDF-CONTENU-SECRET');
  await Order.create({
    userId: new mongoose.Types.ObjectId(), number: 'CP2026-900001', invoice: { number: 'F-2026-9001', issuedAt: ilYa(110) },
    status: 'delivered', orderType: 'exchange', accountType: 'particulier',
    items: [{ name: 'Mécatronique DSG7 DQ200 reconditionnée', sku: '0AM 325 025', unitPriceCents: 129000, quantity: 1, lineTotalCents: 129000 }],
    shippingAddress: adresse, billingAddress: adresse,
    itemsSubtotalCents: 129000, shippingCostCents: 6900, totalCents: 145800,
    statusHistory: [{ status: 'paid', changedAt: ilYa(110), changedBy: 'mollie' }, { status: 'delivered', changedAt: ilYa(101), changedBy: 'admin' }],
    shipments: [{ label: 'Envoi', carrier: 'UPS', trackingNumber: '1ZTEST0001', createdAt: ilYa(109), createdBy: 'atelier', document: { originalName: 'L-1.pdf', fileData: SECRET } }],
    emailsSent: [{ type: 'order_confirmation', sentAt: ilYa(110), recipientEmail: 'valerie.sorel@example.com' }],
    smsSent: [{ type: 'shipment', sentAt: ilYa(109), recipientPhone: TELEPHONE_SMS }],
    documents: [{ docType: 'etiquette_envoi', originalName: 'L-1.pdf', fileData: SECRET, uploadedAt: ilYa(109) }],
    consigne: { chargedTotalCents: 9900, lines: [{ productId: new mongoose.Types.ObjectId(), name: 'Mécatronique', quantity: 1, amountCents: 9900, delayDays: 30, dueAt: ilYa(71) }] },
    refunds: [{ amountCents: 1000, reason: 'geste', method: 'mollie', createdAt: ilYa(50), providerRawResponse: { cle: 'REPONSE-BRUTE-PRESTATAIRE' } }],
    creditNotes: [{ number: 'AV-2026-0001', issuedAt: ilYa(50), totalCents: 1000, pdfData: SECRET }],
    purchase: { supplier: 'Atelier partenaire', invoiceRef: 'INV-77', priceCents: 61234, invoiceFile: { originalName: 'achat.pdf', data: SECRET } },
    noteInternal: 'paiement mollie',
  });

  const empreinte = async () => {
    const h = crypto.createHash('sha256');
    for (const nom of ['savtickets', 'orders', 'savFiles.files', 'savFiles.chunks']) {
      const docs = await mongoose.connection.db.collection(nom).find({}).sort({ _id: 1 }).toArray();
      assert.ok(docs.length > 0, `collection ${nom} vide : l'empreinte ne prouverait rien`);
      h.update(nom + ':' + docs.length + ':' + JSON.stringify(docs));
    }
    return h.digest('hex');
  };
  assert.strictEqual(await SavTicket.countDocuments({}), 4);
  const avant = await empreinte();

  /* ── Outils déclarés ─────────────────────────────────────────────────── */
  await t.test('les quatre outils SAV sont déclarés, sans retirer les anciens', async () => {
    const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const noms = r.result.tools.map((o) => o.name);
    for (const nom of ['getBusinessOverview', 'getProductPerformance', 'getCampaignPerformance', 'getFunnelLeaks',
      'listSavTickets', 'getSavTicket', 'getSavAttachment', 'getOrder']) {
      assert.ok(noms.includes(nom), `outil ${nom} manquant`);
    }
    for (const o of r.result.tools) assert.strictEqual(o.inputSchema.type, 'object');
  });

  /* ── Liste ───────────────────────────────────────────────────────────── */
  await t.test('listSavTickets : tickets ouverts, le plus en retard d\'abord', async () => {
    const d = json(await appel(dispatch, 'listSavTickets'));
    assert.deepStrictEqual(d.tickets.map((x) => x.id), ['SAV-2026-0901', 'SAV-2026-0902', 'SAV-2026-0904']);
    assert.strictEqual(d.counts.open, 3);
    assert.strictEqual(d.counts.overdue, 1);
    assert.deepStrictEqual(d.tickets.map((x) => x.waiting_on), ['us', 'client', 'us']);
    assert.strictEqual(d.tickets[0].age_days, 80);
    assert.strictEqual(d.tickets[0].days_since_last_client_message, 3);
    assert.ok(d.tickets[0].overdue_days >= 72);
  });

  await t.test('listSavTickets : filtres', async () => {
    const ids = async (args) => json(await appel(dispatch, 'listSavTickets', args)).tickets.map((x) => x.id);
    // « us » et « client » se partagent tous les tickets ouverts, sans trou ni doublon.
    assert.deepStrictEqual(await ids({ waitingOn: 'us' }), ['SAV-2026-0901', 'SAV-2026-0904']);
    assert.deepStrictEqual(await ids({ waitingOn: 'client' }), ['SAV-2026-0902']);
    assert.deepStrictEqual(await ids({ onlyOverdue: true }), ['SAV-2026-0901']);
    assert.deepStrictEqual(await ids({ motif: 'retard_livraison' }), ['SAV-2026-0902']);
    assert.deepStrictEqual(await ids({ status: 'clos' }), ['SAV-2026-0903']);
    assert.deepStrictEqual(await ids({ search: 'kerlan' }), ['SAV-2026-0902']);
    assert.deepStrictEqual(await ids({ search: 'CP2026-900001' }), ['SAV-2026-0901']);
    // Une recherche est un texte, jamais une expression régulière ni un opérateur.
    assert.deepStrictEqual(await ids({ search: '.*' }), []);
    assert.strictEqual((await ids({ search: { $ne: '' } })).length, 3);
    assert.strictEqual((await ids({ status: { $ne: 'x' } })).length, 3);
    assert.strictEqual((await ids({ motif: { $ne: 'x' } })).length, 3);
    assert.strictEqual((await ids({ includeClosed: true })).length, 4);
    const page = json(await appel(dispatch, 'listSavTickets', { limit: 1 }));
    assert.strictEqual(page.tickets.length, 1);
    assert.strictEqual(page.next_cursor, '1');
    assert.deepStrictEqual(await ids({ limit: 1, cursor: page.next_cursor }), ['SAV-2026-0902']);
  });

  await t.test('listSavTickets : ni téléphone ni adresse', async () => {
    const brut = texte(await appel(dispatch, 'listSavTickets', { includeClosed: true }));
    assert.ok(!brut.includes(TELEPHONE));
    assert.ok(!brut.includes('0699887766'));
    assert.ok(!brut.includes(RUE));
  });

  /* ── Ticket ──────────────────────────────────────────────────────────── */
  await t.test('getSavTicket : dossier complet', async () => {
    const res = await appel(dispatch, 'getSavTicket', { ticketId: 'sav-2026-901' });
    const d = json(res);
    assert.strictEqual(d.id, 'SAV-2026-0901');
    assert.strictEqual(d.client.type, 'B2C');
    assert.strictEqual(d.messages_total, 5);
    assert.strictEqual(d.messages.length, 5);
    assert.deepStrictEqual(d.messages.map((m) => m.from), ['client', 'agent', 'agent', 'client', 'client']);
    assert.deepStrictEqual(d.messages.map((m) => m.internal), [false, false, true, false, false]);
    assert.strictEqual(d.messages[0].attachments[0].file_id, capture.id);
    // Un message interminable est coupé, et le dit.
    assert.strictEqual(d.messages[3].body.length, 8000);
    assert.strictEqual(d.messages[3].truncated, true);
    assert.strictEqual(d.messages[4].truncated, undefined);
    assert.deepStrictEqual(d.client_documents.map((x) => x.file_id).sort(), [pdfScanne.id, pdfTexte.id].sort());
    assert.strictEqual(d.timing.days_since_request, 80);
    assert.strictEqual(d.timing.past_day_30, true);
    assert.strictEqual(d.timing.waiting_on, 'us');
    assert.deepStrictEqual(d.declared_by_client.fault_codes, ['P0607']);
    assert.strictEqual(d.vehicle.mileage_km, 127822);
    assert.strictEqual(d.part.serial, 'TCU-2025-11-03');
    assert.strictEqual(d.order.found, true);
    assert.strictEqual(d.order.number, 'CP2026-900001');
    assert.strictEqual(d.order.total_eur, 1458);
    assert.strictEqual(d.order.consigne.charged_total_eur, 99);
    const brut = texte(res);
    assert.ok(!brut.includes(TELEPHONE), 'le téléphone du client ne sort pas');
    assert.ok(!brut.includes('0388000000'), 'le téléphone du garage ne sort pas');
    assert.ok(!brut.includes(RUE), 'l\'adresse ne sort pas');
  });

  await t.test('getSavTicket : derniers messages, type de client non résolu, ticket inconnu', async () => {
    for (const n of [1, '1']) { // un assistant envoie parfois le nombre sous forme de texte
      const d = json(await appel(dispatch, 'getSavTicket', { ticketId: 'SAV-2026-0901', lastMessages: n }));
      assert.strictEqual(d.messages.length, 1);
      assert.strictEqual(d.messages_total, 5);
      assert.strictEqual(d.messages[0].body, 'Toujours sans nouvelles.');
    }
    const sans = json(await appel(dispatch, 'getSavTicket', { ticketId: 'SAV-2026-0902' }));
    assert.deepStrictEqual(sans.order, { found: false, reference: 'CP2026-900002' });
    assert.strictEqual(sans.timing.past_day_30, false);
    // Un type non résolu reste « inconnu » : il ne devient pas « particulier » par défaut.
    assert.strictEqual(sans.client.type, 'inconnu');
    const vide = json(await appel(dispatch, 'getSavTicket', { ticketId: 'SAV-2026-0904' }));
    assert.strictEqual(vide.messages_total, 0);
    assert.strictEqual(vide.timing.waiting_on, 'us');
    for (const ticketId of ['SAV-2026-9999', '', { $ne: '' }, ['SAV-2026-0901', 'x']]) {
      const res = await appel(dispatch, 'getSavTicket', { ticketId });
      assert.strictEqual(res.isError, true);
    }
  });

  /* ── Pièces jointes ──────────────────────────────────────────────────── */
  await t.test('getSavAttachment : une image légère part telle quelle, avec son vrai type', async () => {
    const res = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: capture.id });
    const d = json(res);
    assert.strictEqual(d.readable, true);
    assert.deepStrictEqual([d.shown_width, d.shown_height], [2400, 1200]);
    assert.strictEqual(images(res)[0].mimeType, 'image/png');
    // Un JPEG déposé sous le nom « photo.png » est annoncé pour ce qu'il est.
    const faux = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: jpegNommePng.id });
    assert.strictEqual(images(faux)[0].mimeType, 'image/jpeg');
  });

  await t.test('getSavAttachment : une photo lourde est rendue réduite', async () => {
    const res = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: photo.id });
    const d = json(res);
    assert.ok(d.size_bytes > 2 * 1024 * 1024, 'la photo de test doit dépasser 2 Mo');
    assert.strictEqual(d.readable, true);
    const [img] = images(res);
    assert.strictEqual(img.mimeType, 'image/jpeg');
    const lue = await Jimp.read(Buffer.from(img.data, 'base64'));
    assert.deepStrictEqual([lue.width, lue.height], [1400, 1050]);
  });

  await t.test('getSavAttachment : une image piégée est refusée sans être décodée', async () => {
    const debut = Date.now();
    const avantMemoire = process.memoryUsage().rss;
    const res = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: piege.id });
    const d = json(res);
    assert.strictEqual(d.readable, false);
    assert.match(d.reason, /12000 × 12000/);
    assert.strictEqual(images(res).length, 0);
    assert.ok(Date.now() - debut < 1000, 'refus immédiat');
    assert.ok(process.memoryUsage().rss - avantMemoire < 50 * 1024 * 1024, 'aucune allocation massive');
  });

  await t.test('getSavAttachment : un PDF scanné est rendu page par page', async () => {
    const p1 = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: pdfScanne.id });
    const d1 = json(p1);
    assert.strictEqual(d1.pdf_pages, 4);
    assert.strictEqual(d1.scanned_pages, 4);
    assert.deepStrictEqual(d1.shown_scanned_pages, [1, 2, 3]);
    assert.strictEqual(d1.next_page, 4);
    assert.strictEqual(d1.warning, null);
    assert.strictEqual(images(p1).length, 3);
    for (const page of [4, '4']) {
      const p2 = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: pdfScanne.id, page });
      const d2 = json(p2);
      assert.deepStrictEqual(d2.shown_scanned_pages, [4]);
      assert.strictEqual(d2.next_page, null);
      assert.strictEqual(images(p2).length, 1);
      const lue = await Jimp.read(Buffer.from(images(p2)[0].data, 'base64'));
      assert.deepStrictEqual([lue.width, lue.height], [1000, 1400]);
    }
    const trop = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: pdfScanne.id, page: 9 });
    assert.strictEqual(json(trop).readable, false);
    assert.match(json(trop).reason, /4 page/);
    assert.strictEqual(images(trop).length, 0);
  });

  await t.test('getSavAttachment : un PDF texte est annoncé illisible, même avec un logo', async () => {
    for (const fichier of [pdfTexte, pdfLogo]) {
      const res = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: fichier.id });
      const d = json(res);
      assert.strictEqual(d.readable, false);
      assert.match(d.reason, /texte/);
      assert.strictEqual(images(res).length, 0, 'un logo n\'est pas une page');
    }
  });

  await t.test('getSavAttachment : un PDF mixte prévient que tout n\'est pas montré', async () => {
    const res = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: pdfMixte.id });
    const d = json(res);
    assert.strictEqual(d.readable, true);
    assert.strictEqual(d.pdf_pages, 2);
    assert.strictEqual(d.scanned_pages, 1);
    assert.strictEqual(images(res).length, 1);
    assert.match(d.warning, /1 page\(s\) sur 2/);
    assert.match(d.warning, /texte que cet outil ne lit pas/);
    // Objets compressés : ni le nombre de pages ni le texte ne sont visibles,
    // l'outil prévient quand même qu'il ne montre peut-être pas tout.
    const c = json(await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId: pdfMixteCompresse.id }));
    assert.strictEqual(c.readable, true);
    assert.strictEqual(c.pdf_pages, null);
    assert.match(c.warning, /peut contenir des pages ou du texte/);
  });

  await t.test('getSavAttachment : refuse tout fichier hors du ticket nommé', async () => {
    const cas = [
      { ticketId: 'SAV-2026-0901', fileId: fichierAutreTicket.id },   // fichier d'un autre client
      { ticketId: 'SAV-2026-0901', fileId: fichierInterne.id },       // fichier interne sans ticket
      { ticketId: 'SAV-2026-0901', fileId: 'a'.repeat(24) },          // fichier inexistant
    ];
    const messages = [];
    for (const args of cas) {
      const res = await appel(dispatch, 'getSavAttachment', args);
      assert.strictEqual(res.isError, true);
      assert.strictEqual(images(res).length, 0);
      messages.push(texte(res).replace(/[a-f0-9]{24}/g, 'ID'));
    }
    // Même réponse dans les trois cas : on n'apprend pas qu'un fichier existe ailleurs.
    assert.strictEqual(new Set(messages).size, 1);
    for (const fileId of ['../etc/passwd', { $ne: null }, '']) {
      const res = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0901', fileId });
      assert.strictEqual(res.isError, true);
    }
    const bon = await appel(dispatch, 'getSavAttachment', { ticketId: 'SAV-2026-0902', fileId: fichierAutreTicket.id });
    assert.strictEqual(json(bon).readable, true);
  });

  /* ── Commande ────────────────────────────────────────────────────────── */
  await t.test('getOrder : par numéro de commande ou de facture', async () => {
    const res = await appel(dispatch, 'getOrder', { orderNumber: 'CP2026-900001' });
    const d = json(res);
    assert.strictEqual(d.number, 'CP2026-900001');
    assert.strictEqual(d.account_type, 'particulier');
    assert.strictEqual(d.totals.total_eur, 1458);
    assert.strictEqual(d.items[0].unit_price_eur, 1290);
    assert.strictEqual(d.shipments[0].tracking_number, '1ZTEST0001');
    assert.strictEqual(d.shipments[0].has_document, true);
    assert.strictEqual(d.consigne.lines[0].amount_eur, 99);
    assert.strictEqual(d.refunds[0].amount_eur, 10);
    assert.strictEqual(d.purchase.supplier, 'Atelier partenaire');
    assert.strictEqual(d.purchase.has_invoice_file, true);
    assert.deepStrictEqual(d.sav_tickets.map((x) => x.id), ['SAV-2026-0901']);
    assert.deepStrictEqual(d.documents.map((x) => x.name), ['L-1.pdf']);
    const brut = texte(res);
    assert.ok(!brut.includes(TELEPHONE) && !brut.includes(TELEPHONE_SMS), 'pas de téléphone');
    assert.ok(!brut.includes(RUE), 'pas d\'adresse postale');
    assert.ok(!brut.includes('CONTENU-SECRET') && !brut.includes(SECRET.toString('base64')) && !/fileData|pdfData/.test(brut), 'pas de contenu de fichier');
    assert.ok(!brut.includes('REPONSE-BRUTE-PRESTATAIRE'), 'pas de réponse brute du prestataire de paiement');
    assert.ok(!brut.includes('612.34') && !brut.includes('61234'), 'pas de prix d\'achat');
    const parFacture = json(await appel(dispatch, 'getOrder', { orderNumber: 'F-2026-9001' }));
    assert.strictEqual(parFacture.number, 'CP2026-900001');
    // Un objet à la place d'un numéro ne devient pas une requête Mongo.
    for (const orderNumber of ['CP2026-000000', { $ne: '' }, '', 'x'.repeat(5000)]) {
      const r = await appel(dispatch, 'getOrder', { orderNumber });
      assert.strictEqual(r.isError, true);
    }
  });

  /* ── Lecture seule ───────────────────────────────────────────────────── */
  await t.test('aucun appel n\'a écrit en base, fichiers compris', async () => {
    assert.strictEqual(await empreinte(), avant);
  });

  /* ── Accès ───────────────────────────────────────────────────────────── */
  await t.test('sans jeton, le connecteur ne rend rien ; un lot est plafonné', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app);
    app.use('/admin/api/sav/agent', require('../../src/routes/api/savAgent'));
    const http = app.listen(0);
    t.after(() => new Promise((r) => http.close(r)));
    const base = `http://127.0.0.1:${http.address().port}`;
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listSavTickets', arguments: {} } };
    const poster = (corps, jeton) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
      body: JSON.stringify(corps),
    });

    const sans = await poster(message);
    assert.strictEqual(sans.status, 401);
    assert.ok(!(await sans.text()).includes('SAV-2026'));
    for (const faux of ['mauvais', 'jeton-de-test-mcp-sa', 'jeton-de-test-mcp-savX']) {
      assert.strictEqual((await poster(message, faux)).status, 401);
    }
    assert.strictEqual((await fetch(`${base}/mcp/mauvais`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) })).status, 404);

    const bon = await poster(message, 'jeton-de-test-mcp-sav');
    assert.strictEqual(bon.status, 200);
    assert.strictEqual(JSON.parse((await bon.json()).result.content[0].text).tickets.length, 3);

    assert.strictEqual((await poster(Array(10).fill(message), 'jeton-de-test-mcp-sav')).status, 200);
    assert.strictEqual((await poster(Array(11).fill(message), 'jeton-de-test-mcp-sav')).status, 400);

    // L'API « agent » d'origine répond comme avant : tous les tickets non archivés,
    // clos compris, et un opérateur glissé dans l'URL est ignoré.
    const agent = (chemin) => fetch(`${base}/admin/api/sav/agent${chemin}`, { headers: { Authorization: 'Bearer cle-agent-de-test' } }).then((r) => r.json());
    const file = await agent('/queue');
    assert.strictEqual(file.tickets.length, 4);
    assert.deepStrictEqual(file.counts, { open: 3, overdue: 1, client_replied: 1, awaiting_client: 1 });
    assert.strictEqual((await agent('/queue?status=clos')).tickets.length, 1);
    assert.strictEqual((await agent('/queue?status[$ne]=clos')).tickets.length, 4);
    const detail = await agent('/tickets/SAV-2026-0901');
    assert.strictEqual(detail.messages.length, 5);
    assert.strictEqual(detail.client.phone, TELEPHONE, 'le contrat de l\'API agent n\'est pas modifié');
  });
});
