/** LOCAL UNIQUEMENT (127.0.0.1:27018) — réinitialise l'admin primaire du mongo
 *  local avec un identifiant dev connu, pour se connecter à /admin sur localhost.
 *  N'affecte JAMAIS la prod (la prod utilise ADMIN_EMAIL/ADMIN_PASSWORD d'env). */
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/autoliva_local';
if (!/127\.0\.0\.1|localhost/.test(uri)) {
  console.error('Refus : ce script ne tourne que sur un mongo LOCAL. URI =', uri);
  process.exit(1);
}
process.env.MONGODB_URI = uri;
const mongoose = require('mongoose');
const adminUsers = require('../src/services/adminUsers');
const AdminUser = require('../src/models/AdminUser');

const EMAIL = 'admin@carpartsfrance.fr';
const PASSWORD = 'admin12345';

(async () => {
  await mongoose.connect(uri);
  await AdminUser.deleteMany({}); // table rase locale
  const created = await adminUsers.ensurePrimaryAdminUser({ legacyEmail: EMAIL, legacyPassword: PASSWORD });
  if (!created) { console.error('Échec création admin'); process.exit(1); }
  // vérif immédiate
  const ok = await adminUsers.authenticateAdminUser({ email: EMAIL, password: PASSWORD });
  console.log('Admin local réinitialisé — auth vérifiée :', !!ok);
  console.log('  email    :', EMAIL);
  console.log('  password :', PASSWORD);
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
