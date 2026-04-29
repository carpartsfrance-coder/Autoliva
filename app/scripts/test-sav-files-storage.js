#!/usr/bin/env node
// Test bout en bout du nouveau stockage GridFS pour les fichiers SAV.
// Écrit un fichier de test, le relit, vérifie l'intégrité, puis le supprime.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const mongoose = require('mongoose');
const savFileStorage = require('../src/services/savFileStorage');

async function main() {
  console.log('Connexion MongoDB…');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ connecté à', mongoose.connection.name);

  // Buffer test : 64 Ko de bytes pseudo-aléatoires
  const original = crypto.randomBytes(64 * 1024);
  const sha = crypto.createHash('sha256').update(original).digest('hex');
  console.log(`\nFichier test : ${original.length} octets, sha256=${sha.slice(0, 16)}…`);

  // 1. Upload
  console.log('\n1) Upload via savFileStorage.saveBuffer()');
  const stored = await savFileStorage.saveBuffer({
    buffer: original,
    filename: 'test-storage.bin',
    mime: 'application/octet-stream',
    metadata: {
      ticketNumero: '__TEST__',
      kind: 'storage_test',
      uploadedBy: 'system',
    },
  });
  console.log(`   ✓ id=${stored.id}`);
  console.log(`   ✓ url=${stored.url}`);
  console.log(`   ✓ size=${stored.size}`);

  // 2. Métadonnées
  console.log('\n2) Lecture des métadonnées via findOne()');
  const meta = await savFileStorage.findOne(stored.id);
  console.log(`   ✓ filename=${meta.filename}`);
  console.log(`   ✓ length=${meta.length}`);
  console.log(`   ✓ contentType=${meta.contentType}`);
  console.log(`   ✓ metadata.ticketNumero=${meta.metadata.ticketNumero}`);
  console.log(`   ✓ metadata.kind=${meta.metadata.kind}`);

  // 3. Lecture buffer
  console.log('\n3) Relecture du buffer via readBuffer()');
  const readBack = await savFileStorage.readBuffer(stored.id);
  const sha2 = crypto.createHash('sha256').update(readBack).digest('hex');
  console.log(`   ✓ ${readBack.length} octets, sha256=${sha2.slice(0, 16)}…`);
  if (sha !== sha2) {
    throw new Error(`Intégrité KO : sha original=${sha} ≠ relu=${sha2}`);
  }
  console.log('   ✓ Intégrité SHA-256 vérifiée');

  // 4. Recherche par métadonnées
  console.log('\n4) Recherche via findByMetadata({ ticketNumero: __TEST__ })');
  const found = await savFileStorage.findByMetadata({
    'metadata.ticketNumero': '__TEST__',
  });
  console.log(`   ✓ ${found.length} fichier(s) trouvé(s)`);

  // 5. Extract id from URL
  console.log('\n5) extractIdFromUrl()');
  const extracted = savFileStorage.extractIdFromUrl(stored.url);
  console.log(`   ✓ ${stored.url} → ${extracted}`);
  if (extracted !== stored.id) throw new Error('extractIdFromUrl KO');

  // 6. Suppression
  console.log('\n6) Nettoyage : deleteFile()');
  const ok = await savFileStorage.deleteFile(stored.id);
  console.log(`   ✓ deleteFile() → ${ok}`);
  const after = await savFileStorage.findOne(stored.id);
  if (after) throw new Error('Le fichier devrait être supprimé');
  console.log('   ✓ findOne() retourne null après suppression');

  console.log('\n✅ TOUT OK — GridFS opérationnel pour les fichiers SAV');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ ÉCHEC :', err);
  process.exit(1);
});
