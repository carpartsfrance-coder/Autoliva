const mongoose = require('mongoose');

const Order = require('../models/Order');
const User = require('../models/User');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseIntSafe(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function sendConsigneReminders() {
  const dbConnected = mongoose.connection.readyState === 1;
  if (!dbConnected) return;

  const reminderDays = parseIntSafe(process.env.CONSIGNE_REMINDER_DAYS || '7', 7);
  const now = new Date();
  const soonLimit = addDays(now, reminderDays);

  // ─── Rappels "bientôt dû" ───
  const soonOrders = await Order.find({
    $or: [
      { 'notifications.consigneReminderSoonSentAt': { $exists: false } },
      { 'notifications.consigneReminderSoonSentAt': null },
    ],
    'consigne.lines': {
      $elemMatch: { receivedAt: null, dueAt: { $gte: now, $lte: soonLimit } },
    },
    status: { $nin: ['cancelled', 'refunded', 'draft'] },
  })
    .select('_id number userId consigne notifications')
    .limit(200)
    .lean();

  let soonSent = 0;
  for (const order of soonOrders) {
    try {
      if (!order || !order.userId) continue;
      const user = await User.findById(order.userId).select('_id email firstName smsOptIn').lean();
      if (!user || !user.email) continue;

      const sent = await emailService.sendConsigneReminderSoonEmail({ order, user });
      emailService.logEmailSent({ orderId: order._id, emailType: 'consigne_reminder_soon', recipientEmail: user.email, result: sent });
      smsService.sendConsigneReminderSoonSms({ order, user }).catch(() => {});
      if (sent && sent.ok) {
        await Order.updateOne(
          { _id: order._id, $or: [{ 'notifications.consigneReminderSoonSentAt': { $exists: false } }, { 'notifications.consigneReminderSoonSentAt': null }] },
          { $set: { 'notifications.consigneReminderSoonSentAt': new Date() } }
        );
        soonSent++;
      }
    } catch (err) {
      console.error('[consigne-reminders] Erreur rappel (soon):', err.message || err);
    }
  }

  // ─── Alertes "en retard" ───
  const overdueOrders = await Order.find({
    $or: [
      { 'notifications.consigneOverdueSentAt': { $exists: false } },
      { 'notifications.consigneOverdueSentAt': null },
    ],
    'consigne.lines': {
      $elemMatch: { receivedAt: null, dueAt: { $lt: now } },
    },
    status: { $nin: ['cancelled', 'refunded', 'draft'] },
  })
    .select('_id number userId consigne notifications')
    .limit(200)
    .lean();

  let overdueSent = 0;
  for (const order of overdueOrders) {
    try {
      if (!order || !order.userId) continue;
      const user = await User.findById(order.userId).select('_id email firstName smsOptIn').lean();
      if (!user || !user.email) continue;

      const sent = await emailService.sendConsigneOverdueEmail({ order, user });
      emailService.logEmailSent({ orderId: order._id, emailType: 'consigne_overdue', recipientEmail: user.email, result: sent });
      smsService.sendConsigneOverdueSms({ order, user }).catch(() => {});
      if (sent && sent.ok) {
        await Order.updateOne(
          { _id: order._id, $or: [{ 'notifications.consigneOverdueSentAt': { $exists: false } }, { 'notifications.consigneOverdueSentAt': null }] },
          { $set: { 'notifications.consigneOverdueSentAt': new Date() } }
        );
        overdueSent++;
      }
    } catch (err) {
      console.error('[consigne-reminders] Erreur retard:', err.message || err);
    }
  }

  if (soonSent > 0 || overdueSent > 0) {
    console.log(`[consigne-reminders] ${soonSent} rappel(s) envoyé(s), ${overdueSent} retard(s) envoyé(s).`);
  }
}

module.exports = { sendConsigneReminders };
