const crypto = require('crypto');

const AdminUser = require('../models/AdminUser');
const { ROLES } = require('../permissions');

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hashPassword(password, salt) {
  const inputPassword = getTrimmedString(password);
  const inputSalt = getTrimmedString(salt);
  if (!inputPassword || !inputSalt) return '';

  try {
    return crypto.scryptSync(inputPassword, inputSalt, 64).toString('hex');
  } catch (err) {
    return '';
  }
}

function verifyPassword({ password, salt, hash } = {}) {
  const computed = hashPassword(password, salt);
  if (!computed || !hash) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  } catch (err) {
    return false;
  }
}

function buildPasswordRecord(password) {
  const safePassword = getTrimmedString(password);
  if (!safePassword || safePassword.length < 8) {
    return null;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(safePassword, salt);
  if (!hash) return null;

  return { salt, hash };
}

function sanitizeAdminForSession(adminUser) {
  if (!adminUser) return null;
  return {
    adminUserId: String(adminUser._id),
    email: normalizeEmail(adminUser.email),
    firstName: getTrimmedString(adminUser.firstName),
    lastName: getTrimmedString(adminUser.lastName),
    role: getTrimmedString(adminUser.role) || ROLES.EMPLOYE,
  };
}

async function ensurePrimaryAdminUser({ legacyEmail, legacyPassword, legacyPasswordHash, legacyPasswordSalt } = {}) {
  const existingCount = await AdminUser.countDocuments({});
  if (existingCount > 0) {
    return AdminUser.findOne({ role: ROLES.OWNER }).sort({ createdAt: 1 });
  }

  const email = normalizeEmail(legacyEmail);
  const firstName = 'Admin';
  const lastName = 'Principal';

  let passwordHash = getTrimmedString(legacyPasswordHash);
  let passwordSalt = getTrimmedString(legacyPasswordSalt);

  if (!passwordHash || !passwordSalt) {
    const record = buildPasswordRecord(legacyPassword);
    if (!record) return null;
    passwordHash = record.hash;
    passwordSalt = record.salt;
  }

  if (!email) return null;

  try {
    return await AdminUser.create({
      firstName,
      lastName,
      email,
      passwordHash,
      passwordSalt,
      role: ROLES.OWNER,
      isActive: true,
      passwordUpdatedAt: new Date(),
    });
  } catch (err) {
    return AdminUser.findOne({ email });
  }
}

async function authenticateAdminUser({ email, password } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const safePassword = getTrimmedString(password);
  if (!normalizedEmail || !safePassword) return null;

  const adminUser = await AdminUser.findOne({ email: normalizedEmail, isActive: true });
  if (!adminUser) return null;

  const passwordOk = verifyPassword({
    password: safePassword,
    salt: adminUser.passwordSalt,
    hash: adminUser.passwordHash,
  });

  if (!passwordOk) return null;

  return adminUser;
}

async function getPrimaryAdminUser() {
  return AdminUser.findOne({ role: ROLES.OWNER }).sort({ createdAt: 1 });
}

async function touchLastLogin(adminUserId) {
  if (!adminUserId) return;
  await AdminUser.updateOne({ _id: adminUserId }, { $set: { lastLoginAt: new Date() } });
}

async function listAdminUsers() {
  const users = await AdminUser.find({}).sort({ role: 1, createdAt: 1 }).lean();
  return users.map((user) => ({
    id: String(user._id),
    firstName: getTrimmedString(user.firstName),
    lastName: getTrimmedString(user.lastName),
    fullName: `${getTrimmedString(user.firstName)} ${getTrimmedString(user.lastName)}`.trim(),
    email: normalizeEmail(user.email),
    role: getTrimmedString(user.role) || ROLES.EMPLOYE,
    isActive: user.isActive !== false,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    lastLoginAt: user.lastLoginAt || null,
  }));
}

async function createStaffAdminUser({ firstName, lastName, email, password, createdByAdminUserId } = {}) {
  const safeFirstName = getTrimmedString(firstName);
  const safeLastName = getTrimmedString(lastName);
  const safeEmail = normalizeEmail(email);
  const record = buildPasswordRecord(password);

  if (!safeFirstName || !safeLastName || !safeEmail || !record) {
    return null;
  }

  return AdminUser.create({
    firstName: safeFirstName,
    lastName: safeLastName,
    email: safeEmail,
    passwordHash: record.hash,
    passwordSalt: record.salt,
    role: ROLES.EMPLOYE,
    isActive: true,
    passwordUpdatedAt: new Date(),
    createdByAdminUserId: createdByAdminUserId || null,
  });
}

async function updateOwnPassword({ adminUserId, currentPassword, nextPassword } = {}) {
  const safeId = getTrimmedString(adminUserId);
  const safeCurrent = getTrimmedString(currentPassword);
  const safeNext = getTrimmedString(nextPassword);
  if (!safeId || !safeCurrent || !safeNext || safeNext.length < 8) return { ok: false, reason: 'invalid_input' };

  const adminUser = await AdminUser.findById(safeId);
  if (!adminUser || adminUser.isActive === false) return { ok: false, reason: 'not_found' };

  const currentOk = verifyPassword({
    password: safeCurrent,
    salt: adminUser.passwordSalt,
    hash: adminUser.passwordHash,
  });
  if (!currentOk) return { ok: false, reason: 'invalid_current_password' };

  const record = buildPasswordRecord(safeNext);
  if (!record) return { ok: false, reason: 'invalid_next_password' };

  adminUser.passwordSalt = record.salt;
  adminUser.passwordHash = record.hash;
  adminUser.passwordUpdatedAt = new Date();
  await adminUser.save();

  return { ok: true };
}

async function updatePrimaryAdminPassword(nextPassword) {
  const adminUser = await getPrimaryAdminUser();
  if (!adminUser || adminUser.isActive === false) return { ok: false, reason: 'not_found' };

  const record = buildPasswordRecord(nextPassword);
  if (!record) return { ok: false, reason: 'invalid_next_password' };

  adminUser.passwordSalt = record.salt;
  adminUser.passwordHash = record.hash;
  adminUser.passwordUpdatedAt = new Date();
  await adminUser.save();

  return { ok: true, adminUser };
}

async function toggleAdminUserActive({ adminUserId, isActive } = {}) {
  const safeId = getTrimmedString(adminUserId);
  if (!safeId) return { ok: false, reason: 'invalid_id' };

  const adminUser = await AdminUser.findById(safeId);
  if (!adminUser) return { ok: false, reason: 'not_found' };
  if (adminUser.role === ROLES.OWNER) return { ok: false, reason: 'owner_locked' };

  adminUser.isActive = isActive === true;
  await adminUser.save();
  return { ok: true, adminUser };
}

async function updateAdminUserPasswordByOwner({ adminUserId, nextPassword } = {}) {
  const safeId = getTrimmedString(adminUserId);
  const safeNext = getTrimmedString(nextPassword);
  if (!safeId || !safeNext || safeNext.length < 8) {
    return { ok: false, reason: 'invalid_input' };
  }

  const adminUser = await AdminUser.findById(safeId);
  if (!adminUser) return { ok: false, reason: 'not_found' };
  if (adminUser.role === ROLES.OWNER) return { ok: false, reason: 'owner_locked' };

  const record = buildPasswordRecord(safeNext);
  if (!record) return { ok: false, reason: 'invalid_next_password' };

  adminUser.passwordSalt = record.salt;
  adminUser.passwordHash = record.hash;
  adminUser.passwordUpdatedAt = new Date();
  adminUser.isActive = true;
  await adminUser.save();

  return { ok: true, adminUser };
}

module.exports = {
  normalizeEmail,
  getTrimmedString,
  hashPassword,
  verifyPassword,
  buildPasswordRecord,
  sanitizeAdminForSession,
  ensurePrimaryAdminUser,
  authenticateAdminUser,
  getPrimaryAdminUser,
  touchLastLogin,
  listAdminUsers,
  createStaffAdminUser,
  updateOwnPassword,
  updatePrimaryAdminPassword,
  toggleAdminUserActive,
  updateAdminUserPasswordByOwner,
};
