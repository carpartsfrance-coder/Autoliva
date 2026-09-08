/* Seed LOCAL uniquement — emails en @example.com (RFC 2606 : jamais délivrés). */
require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const AbandonedCart = require('../src/models/AbandonedCart');
  await AbandonedCart.deleteMany({});
  const now = Date.now();
  const d = (h) => new Date(now - h * 3600 * 1000);
  const oid = () => new mongoose.Types.ObjectId();
  const mk = (o) => Object.assign({
    sessionId: 's_' + Math.random().toString(36).slice(2),
    status: 'abandoned', abandonedAt: d(5), lastActivityAt: d(2),
  }, o);
  await AbandonedCart.create([
    // 1. JAMAIS TOUCHÉ, gros panier → bordure ROUGE « À appeler »
    mk({ email: 'jean.dupont@example.com', firstName: 'Jean', lastName: 'Dupont', phone: '0612345678', captureSource: 'devis',
         requested: { plate: 'GD694FM', vehicle: 'Golf 7 2.0 TDI', ref: 'DEV-2107-001', message: 'Bonjour, ma boîte craque en 3e, il me faut un remplacement rapide.' },
         items: [{ productId: oid(), name: 'Boîte DSG7 DQ200 reconditionnée', price: 129900, quantity: 1 }], totalAmountCents: 129900,
         abandonedAt: d(26), lastActivityAt: d(3) }),
    // 2. Relances AUTO en cours (R2 partie hier), jamais touché par le commercial → bordure AMBRE
    mk({ email: 'paul.martin@example.com', firstName: 'Paul', lastName: 'Martin', captureSource: 'guest_checkout',
         items: [{ productId: oid(), name: 'Mécatronique DQ250 + huile', price: 89900, quantity: 1 }], totalAmountCents: 89900,
         status: 'reminded_2', lastRemindedAt: d(20), abandonedAt: d(70), lastActivityAt: d(70) }),
    // 3. CONTACTÉE par le commercial (email + SMS + note) → bordure BLEUE
    mk({ email: 'emma.bernard@example.com', firstName: 'Emma', lastName: 'Bernard', phone: '0755512345', captureSource: 'cart_activity',
         items: [{ productId: oid(), name: 'Turbo GT1749V échange standard', price: 45000, quantity: 1 }], totalAmountCents: 45000,
         status: 'reminded_1', lastRemindedAt: d(30), manualStatus: 'contacted', manualStatusByName: 'Kevin', manualStatusAt: d(4),
         manualEmailsSent: 1, manualSmsSent: 1, lastManualContactAt: d(4),
         notes: [
           { text: '📧 Email envoyé [relance_panier] : "Votre turbo vous attend"', addedByName: 'Kevin', addedAt: d(6) },
           { text: 'Appelée : intéressée mais attend le diagnostic de son garagiste. À rappeler jeudi matin.', addedByName: 'Kevin', addedAt: d(4) },
         ],
         abandonedAt: d(50), lastActivityAt: d(8) }),
    // 4. Téléphone seul, jamais touché → ROUGE
    mk({ phone: '0699887766', firstName: 'Karim', captureSource: 'contact',
         requested: { message: 'Rappellez-moi pour un pont arrière Master 3' }, abandonedAt: d(9), lastActivityAt: d(9) }),
    // 5. GAGNÉE (convertie par Killian) → VERTE
    mk({ email: 'lea.rousseau@example.com', firstName: 'Léa', lastName: 'Rousseau', captureSource: 'devis',
         requested: { plate: 'KL321MN', vehicle: 'Scenic 3 1.5 dCi', ref: 'DEV-2107-004' },
         manualStatus: 'converted', manualStatusByName: 'Killian', manualStatusAt: d(28), recoveredAt: d(28),
         manualEmailsSent: 2, lastManualContactAt: d(28),
         notes: [{ text: 'Commande passée au téléphone — CB à distance.', addedByName: 'Killian', addedAt: d(28) }],
         abandonedAt: d(96), lastActivityAt: d(28) }),
    // 6. Devis moteur : devis envoyé (pipeline) → visible dans « Tous » seulement
    mk({ email: 'marc.petit@example.com', firstName: 'Marc', lastName: 'Petit', phone: '0644455566', captureSource: 'landing_moteurs',
         requested: { plate: 'AB123CD', ref: 'DEV-2107-002', vehicle: 'Moteur occasion · 1.6 HDi 9HZ' },
         engineQuote: { status: 'quote_sent', sentQuotes: [{ sentAt: d(24), version: 1, sellPriceTtc: 2900 }] },
         abandonedAt: d(30), lastActivityAt: d(24) }),
    // 7. Devis boîte : acompte payé → « Tous », bordure verte, badge Acompte reçu
    mk({ email: 'sophie.roux@example.com', firstName: 'Sophie', lastName: 'Roux', phone: '0633344455', captureSource: 'landing_boites',
         requested: { plate: 'EF456GH', ref: 'DEV-2107-003' },
         engineQuote: { status: 'acompte_recu', sentQuotes: [{ sentAt: d(72), version: 1 }], payment: { status: 'paid', amountCents: 50000, paidAt: d(48) } },
         manualStatus: 'converted', manualStatusByName: 'Système (acompte payé)', manualStatusAt: d(48),
         abandonedAt: d(90), lastActivityAt: d(48) }),
    // 8. PERDUE → grise (vue Tous)
    mk({ email: 'nina.faure@example.com', firstName: 'Nina', captureSource: 'cart_activity',
         items: [{ productId: oid(), name: 'Culasse complète 1.9 dCi', price: 38000, quantity: 1 }], totalAmountCents: 38000,
         manualStatus: 'lost', manualStatusByName: 'Kevin', manualStatusAt: d(10),
         notes: [{ text: 'A trouvé moins cher en casse locale.', addedByName: 'Kevin', addedAt: d(10) }],
         abandonedAt: d(120), lastActivityAt: d(12) }),
  ]);
  console.log('Seed OK —', await AbandonedCart.countDocuments({}), 'leads (@example.com uniquement)');
  await mongoose.disconnect();
})();
