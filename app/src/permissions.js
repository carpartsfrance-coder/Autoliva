/**
 * Système de permissions pour le back-office admin CarParts France.
 *
 * Trois rôles :
 *  - owner    : accès total (wildcard '*')
 *  - employe  : accès opérationnel quotidien (commandes, produits, clients…)
 *               sans accès aux KPI financiers, paramètres, facturation, équipe
 *  - comptable: accès LECTURE SEULE à l'espace comptable dédié (/comptable)
 *               pour le cabinet d'expertise externe : factures, avoirs,
 *               remboursements, exports CSV/ZIP. AUCUN accès à /admin.
 */

const ROLES = {
  OWNER: 'owner',
  EMPLOYE: 'employe',
  COMPTABLE: 'comptable',
};

const ABILITIES = {
  owner: ['*'],
  employe: [
    'orders.view',
    'orders.edit',
    'products.view',
    'products.edit',
    'customers.view',
    'customers.edit',
    'promoCodes.manage',
    'blog.manage',
    'legalPages.manage',
    'returns.manage',
    'categories.manage',
    'vehicles.manage',
    'dashboard.operational',
  ],
  comptable: [
    'accounting.view',
    'accounting.invoices.read',
    'accounting.creditNotes.read',
    'accounting.refunds.read',
    'accounting.export',
  ],
};

/**
 * Vérifie si un rôle possède une ability donnée.
 * @param {string} role - Le rôle de l'utilisateur ('owner', 'employe', 'comptable').
 * @param {string} ability - L'ability à vérifier (ex: 'dashboard.financial').
 * @returns {boolean}
 */
function hasAbility(role, ability) {
  const abilities = ABILITIES[role];
  if (!abilities) return false;
  if (abilities.includes('*')) return true;
  return abilities.includes(ability);
}

/**
 * Retourne le libellé français d'un rôle.
 * @param {string} role
 * @returns {string}
 */
function getRoleLabel(role) {
  if (role === ROLES.OWNER) return 'Propriétaire';
  if (role === ROLES.EMPLOYE) return 'Employé';
  if (role === ROLES.COMPTABLE) return 'Comptable';
  return role || '';
}

/**
 * Raccourci pour vérifier si le rôle est owner.
 * @param {string} role
 * @returns {boolean}
 */
function isOwner(role) {
  return role === ROLES.OWNER;
}

/**
 * Raccourci pour vérifier si le rôle est comptable.
 * Utilisé pour rediriger automatiquement vers /comptable après login,
 * et pour bloquer l'accès à /admin.
 * @param {string} role
 * @returns {boolean}
 */
function isComptable(role) {
  return role === ROLES.COMPTABLE;
}

/**
 * URL d'atterrissage par défaut selon le rôle.
 * Le comptable n'a accès à RIEN dans /admin, on l'envoie directement
 * sur son espace dédié.
 * @param {string} role
 * @returns {string}
 */
function defaultLandingForRole(role) {
  if (role === ROLES.COMPTABLE) return '/comptable';
  return '/admin';
}

module.exports = {
  ROLES,
  ABILITIES,
  hasAbility,
  getRoleLabel,
  isOwner,
  isComptable,
  defaultLandingForRole,
};
