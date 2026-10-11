/**
 * Connecteur MCP — petits outils des lectures SAV (sans base de données).
 * Lancé par : npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const { Jimp } = require('jimp');

const { normalizeTicketId, fileIdFromUrl, daysSince } = require('../../src/mcp/util/sav');
const { extractScannedPages } = require('../../src/mcp/util/pdfImages');
const { imageInfo } = require('../../src/mcp/util/imageDims');
const { resizeToJpeg } = require('../../src/mcp/util/imageResize');
const savAgent = require('../../src/services/savAgentService');
const { _internal: attachment } = require('../../src/mcp/tools/getSavAttachment');

/* Copie dans un tableau neuf : pdf-lib lit mal un petit Buffer pris dans la réserve partagée de Node. */
const jpeg = async (w, h, color) => Buffer.from(Uint8Array.from(await new Jimp({ width: w, height: h, color }).getBuffer('image/jpeg', { quality: 80 })));

test('normalizeTicketId : toutes les écritures courantes d\'un numéro de ticket', () => {
  const en2026 = new Date('2026-10-12T10:00:00Z');
  assert.strictEqual(normalizeTicketId('SAV-2026-0134', en2026), 'SAV-2026-0134');
  assert.strictEqual(normalizeTicketId(' sav-2026-134 ', en2026), 'SAV-2026-0134');
  assert.strictEqual(normalizeTicketId('134', en2026), 'SAV-2026-0134');
  assert.strictEqual(normalizeTicketId('0206', en2026), 'SAV-2026-0206');
  assert.strictEqual(normalizeTicketId('SAV-2025-0007', en2026), 'SAV-2025-0007');
  assert.strictEqual(normalizeTicketId('', en2026), '');
  assert.strictEqual(normalizeTicketId(null, en2026), '');
  assert.strictEqual(normalizeTicketId('SAV-2026-0134; drop', en2026), '');
  assert.strictEqual(normalizeTicketId({ $ne: '' }, en2026), '');
});

test('fileIdFromUrl : identifiant d\'un fichier SAV, URL relative ou absolue', () => {
  const id = '6a9839800b34a4ae912904a8';
  assert.strictEqual(fileIdFromUrl(`/sav-files/${id}`), id);
  assert.strictEqual(fileIdFromUrl(`https://autoliva.com/sav-files/${id}?download=1`), id);
  assert.strictEqual(fileIdFromUrl(`/sav-files/${id.toUpperCase()}`), id);
  assert.strictEqual(fileIdFromUrl('/sav-files/pas-un-id'), null);
  assert.strictEqual(fileIdFromUrl('/uploads/facture.pdf'), null);
  assert.strictEqual(fileIdFromUrl(undefined), null);
});

test('daysSince : jours entiers écoulés, jamais négatif', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  assert.strictEqual(daysSince('2026-07-24T00:00:00Z', now), 80);
  assert.strictEqual(daysSince('2026-10-11T12:00:00Z', now), 0);
  assert.strictEqual(daysSince('2026-10-13T00:00:00Z', now), 0);
  assert.strictEqual(daysSince(null, now), null);
});

test('waitingOn : qui doit répondre', () => {
  assert.strictEqual(savAgent.waitingOn({}), 'us');
  assert.strictEqual(savAgent.waitingOn({ lastClientMessageAt: '2026-10-09', lastAdminMessageAt: '2026-10-06' }), 'us');
  assert.strictEqual(savAgent.waitingOn({ lastClientMessageAt: '2026-10-02', lastAdminMessageAt: '2026-10-06' }), 'client');
  assert.strictEqual(savAgent.waitingOn({ lastAdminMessageAt: '2026-10-06' }), 'client');
  assert.strictEqual(savAgent.waitingOn({ lastClientMessageAt: '2026-10-06' }), 'us');
  assert.strictEqual(savAgent.waitingOn({ lastClientMessageAt: '2026-10-06', lastAdminMessageAt: '2026-10-06' }), 'us');
});

test('buildQueueQuery : nouveaux filtres, sans changer les anciens', () => {
  const { buildQueueQuery, TERMINAL } = savAgent._internal;
  // Comportement d'origine de l'API « agent » : inchangé sans les nouveaux paramètres.
  assert.deepStrictEqual(buildQueueQuery({}), { archivedAt: { $in: [null, undefined] } });
  assert.strictEqual(buildQueueQuery({ status: 'clos' }).statut, 'clos');
  assert.strictEqual(buildQueueQuery({ team: 'atelier', motif: 'autre', assignee: 'abc' }).assignedTeam, 'atelier');

  // Un objet venu de la query string (?status[$ne]=x) n'est jamais un opérateur.
  const piege = buildQueueQuery({ status: { $ne: 'x' }, motif: { $gt: '' }, team: ['a'], assignee: { $exists: true } });
  assert.deepStrictEqual(piege, { archivedAt: { $in: [null, undefined] } });

  assert.deepStrictEqual(buildQueueQuery({ open_only: 'true' }).statut, { $nin: TERMINAL });
  // Un statut demandé explicitement l'emporte sur « ouverts seulement ».
  assert.strictEqual(buildQueueQuery({ open_only: 'true', status: 'clos' }).statut, 'clos');
  assert.ok(buildQueueQuery({ awaiting: 'us' }).$expr.$not);
  assert.ok(buildQueueQuery({ awaiting: 'client' }).$expr.$and);
  assert.strictEqual(buildQueueQuery({ awaiting: 'nimporte' }).$expr, undefined);

  const q = buildQueueQuery({ search: 'syren (vw).*' });
  assert.strictEqual(q.$or.length, 4);
  assert.ok(q.$or[0].numero.test('Syren (VW).*'), 'la recherche est littérale et insensible à la casse');
  assert.ok(!q.$or[0].numero.test('syren vw'), 'les caractères spéciaux ne sont pas interprétés');
  assert.strictEqual(buildQueueQuery({ search: '   ' }).$or, undefined);
  assert.strictEqual(buildQueueQuery({ search: { $ne: '' } }).$or[0].numero.source, '\\[object Object\\]');
  assert.strictEqual(buildQueueQuery({ search: 'a'.repeat(500) }).$or[0].numero.source.length, 80);
});

test('guessMime : type déclaré, sinon extension du nom', () => {
  const { guessMime } = attachment;
  assert.strictEqual(guessMime({ contentType: 'image/png' }), 'image/png');
  assert.strictEqual(guessMime({ contentType: 'application/pdf; charset=binary' }), 'application/pdf');
  assert.strictEqual(guessMime({ contentType: 'application/octet-stream', filename: 'Releve.PDF' }), 'application/pdf');
  assert.strictEqual(guessMime({ metadata: { originalName: 'photo.JPG' } }), 'image/jpeg');
  assert.strictEqual(guessMime({ filename: 'video.mov' }), 'application/octet-stream');
});

test('imageInfo : type réel et dimensions lus dans l\'en-tête, sans décoder', async () => {
  const j = await jpeg(640, 480, 0xaa0000ff);
  assert.deepStrictEqual(imageInfo(j), { mime: 'image/jpeg', width: 640, height: 480 });
  const p = await new Jimp({ width: 300, height: 200, color: 0x00aa00ff }).getBuffer('image/png');
  assert.deepStrictEqual(imageInfo(p), { mime: 'image/png', width: 300, height: 200 });
  const g = await new Jimp({ width: 50, height: 40, color: 0x0000aaff }).getBuffer('image/gif');
  assert.deepStrictEqual(imageInfo(g), { mime: 'image/gif', width: 50, height: 40 });

  // WebP étendu (VP8X) : largeur − 1 et hauteur − 1 sur 3 octets chacun.
  const w = Buffer.alloc(40);
  w.write('RIFF', 0, 'latin1'); w.write('WEBP', 8, 'latin1'); w.write('VP8X', 12, 'latin1');
  w.writeUIntLE(4031, 24, 3); w.writeUIntLE(3023, 27, 3);
  assert.deepStrictEqual(imageInfo(w), { mime: 'image/webp', width: 4032, height: 3024 });

  // 600 octets qui annoncent 20 000 × 20 000 px : on le sait sans rien allouer.
  const bombe = Buffer.alloc(600);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bombe, 0);
  bombe.writeUInt32BE(13, 8); bombe.write('IHDR', 12, 'latin1');
  bombe.writeUInt32BE(20000, 16); bombe.writeUInt32BE(20000, 20);
  assert.deepStrictEqual(imageInfo(bombe), { mime: 'image/png', width: 20000, height: 20000 });

  assert.strictEqual(imageInfo(Buffer.from('ceci n\'est pas une image, juste du texte assez long')), null);
  assert.strictEqual(imageInfo(Buffer.alloc(0)), null);
  assert.strictEqual(imageInfo(Buffer.from([0xff, 0xd8, 0xff])), null);
  assert.strictEqual(imageInfo('pas un buffer'), null);
});

test('prepareImage : laisse passer le léger, refuse le démesuré, sans jamais décoder à l\'aveugle', async () => {
  const { prepareImage } = attachment;
  const leger = await prepareImage(await jpeg(1600, 1200, 0x336699ff));
  assert.strictEqual(leger.block.mimeType, 'image/jpeg');
  assert.deepStrictEqual([leger.width, leger.height], [1600, 1200]);

  const bombe = Buffer.alloc(600);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bombe, 0);
  bombe.writeUInt32BE(13, 8); bombe.write('IHDR', 12, 'latin1');
  bombe.writeUInt32BE(20000, 16); bombe.writeUInt32BE(20000, 20);
  const refus = await prepareImage(bombe);
  assert.strictEqual(refus.block, undefined);
  assert.match(refus.reason, /20000 × 20000/);

  const inconnu = await prepareImage(Buffer.from('ftypheic — pas un format lisible ici, mais assez long'));
  assert.match(inconnu.reason, /non lisible/);
});

test('resizeToJpeg : réduit hors du fil principal, refuse proprement un fichier abîmé', async () => {
  const grand = await new Jimp({ width: 3000, height: 1000, color: 0x22446688 }).getBuffer('image/png');
  const out = await resizeToJpeg(grand, { maxWidth: 1400, maxHeight: 2400, quality: 80 });
  assert.deepStrictEqual([out.width, out.height], [1400, 467]);
  assert.deepStrictEqual(imageInfo(out.buffer), { mime: 'image/jpeg', width: 1400, height: 467 });

  const haut = await new Jimp({ width: 800, height: 6000, color: 0x224466ff }).getBuffer('image/png');
  const outHaut = await resizeToJpeg(haut, { maxWidth: 1400, maxHeight: 2400, quality: 80 });
  assert.deepStrictEqual([outHaut.width, outHaut.height], [320, 2400]);

  await assert.rejects(() => resizeToJpeg(Buffer.from('pas une image'), { maxWidth: 1400, maxHeight: 2400, quality: 80 }));
  // Un échec ne bloque pas la file : le travail suivant passe.
  const apres = await resizeToJpeg(grand, { maxWidth: 700, maxHeight: 2400, quality: 80 });
  assert.strictEqual(apres.width, 700);
  // Délai dépassé : le fil est arrêté, l'appel échoue au lieu de rester suspendu.
  await assert.rejects(() => resizeToJpeg(grand, { maxWidth: 1400, maxHeight: 2400, quality: 80, timeoutMs: 1 }), /délai/);
});

test('extractScannedPages : pages scannées dans l\'ordre du fichier, logos ignorés', async () => {
  const doc = await PDFDocument.create();
  const pageA = await doc.embedJpg(await jpeg(1000, 1400, 0xaa0000ff));
  const logo = await doc.embedJpg(await jpeg(600, 320, 0x00aa00ff));
  const pageB = await doc.embedJpg(await jpeg(1600, 1100, 0x0000aaff));
  const p1 = doc.addPage([595, 842]);
  p1.drawImage(pageA, { x: 0, y: 0, width: 595, height: 842 });
  p1.drawImage(logo, { x: 10, y: 800, width: 60, height: 30 });
  doc.addPage([842, 595]).drawImage(pageB, { x: 0, y: 0, width: 842, height: 595 });

  const scan = extractScannedPages(Buffer.from(await doc.save({ useObjectStreams: false })));
  assert.strictEqual(scan.pageCount, 2);
  assert.strictEqual(scan.skipped, 0);
  assert.strictEqual(scan.hasFonts, false);
  assert.strictEqual(scan.encrypted, false);
  assert.deepStrictEqual(scan.images.map((i) => [i.width, i.height]), [[1000, 1400], [1600, 1100]]);
  const relue = await Jimp.read(scan.images[1].bytes);
  assert.strictEqual(relue.width, 1600);

  // Même fichier enregistré avec des objets compressés : les images sont toujours
  // trouvées, seul le nombre de pages n'est plus lisible sans décompresser.
  const compresse = extractScannedPages(Buffer.from(await doc.save()));
  assert.strictEqual(compresse.images.length, 2);
  assert.strictEqual(compresse.pageCount, null);
  assert.strictEqual(compresse.compressedObjects, true);
  assert.strictEqual(scan.compressedObjects, false);
});

test('extractScannedPages : PDF texte, scan non JPEG, fichier qui n\'est pas un PDF', async () => {
  const texte = await PDFDocument.create();
  texte.addPage([595, 842]).drawText('Facture', { x: 50, y: 700, size: 14 });
  const vide = extractScannedPages(Buffer.from(await texte.save({ useObjectStreams: false })));
  assert.deepStrictEqual({ pages: vide.pageCount, images: vide.images.length, skipped: vide.skipped, fonts: vide.hasFonts },
    { pages: 1, images: 0, skipped: 0, fonts: true });

  // Une page scannée non JPEG (PNG → Flate) est comptée, pas rendue.
  const png = await PDFDocument.create();
  const imgPng = await png.embedPng(await new Jimp({ width: 1200, height: 1600, color: 0x123456ff }).getBuffer('image/png'));
  png.addPage([595, 842]).drawImage(imgPng, { x: 0, y: 0, width: 595, height: 842 });
  const nonJpeg = extractScannedPages(Buffer.from(await png.save({ useObjectStreams: false })));
  assert.strictEqual(nonJpeg.images.length, 0);
  assert.strictEqual(nonJpeg.skipped, 1);

  assert.throws(() => extractScannedPages(Buffer.from('ceci n\'est pas un PDF')), /pas un PDF/);
  assert.throws(() => extractScannedPages('texte'), /pas un PDF/);
});

test('extractScannedPages : rien n\'est décompressé, même sur un fichier fabriqué pour exploser', () => {
  // Un flux compressé qui se dilaterait en 200 Mo de zéros : une bibliothèque PDF
  // l'ouvrirait en entier. Ici il est simplement sauté.
  const zlib = require('zlib');
  const bombe = zlib.deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 });
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ' + bombe.length + ' >>\nstream\n', 'latin1'),
    bombe,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
  const avant = process.memoryUsage().rss;
  const debut = Date.now();
  const scan = extractScannedPages(pdf);
  assert.deepStrictEqual({ images: scan.images.length, skipped: scan.skipped }, { images: 0, skipped: 0 });
  assert.ok(Date.now() - debut < 500, 'lecture immédiate');
  assert.ok(process.memoryUsage().rss - avant < 30 * 1024 * 1024, 'aucune allocation massive');
});

test('extractScannedPages : temps linéaire, même sur un fichier fait de milliers de flux vides', () => {
  // Un seul « obj » en tête puis 4 Mo de « stream/endstream » : chercher le
  // dictionnaire en remontant tout le fichier à chaque flux prendrait des minutes.
  const corps = 'stream\nendstream\n'.repeat(250000);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\n' + corps + '%%EOF\n', 'latin1');
  assert.ok(pdf.length > 4 * 1024 * 1024);
  const debut = Date.now();
  const scan = extractScannedPages(pdf);
  assert.ok(Date.now() - debut < 1500, `lecture en ${Date.now() - debut} ms`);
  assert.deepStrictEqual({ images: scan.images.length, skipped: scan.skipped }, { images: 0, skipped: 0 });

  // Même chose sans aucun « obj », et avec des « /Type /Page » par centaines de milliers.
  const sansObj = Buffer.from('%PDF-1.4\n' + corps, 'latin1');
  const debut2 = Date.now();
  extractScannedPages(sansObj);
  assert.ok(Date.now() - debut2 < 1500);
  const pages = extractScannedPages(Buffer.from('%PDF-1.4\n' + '/Type /Page '.repeat(300000), 'latin1'));
  assert.strictEqual(pages.pageCount, 5000, 'le compte de pages est plafonné');
});
