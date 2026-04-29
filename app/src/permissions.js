/**
 * Système de permissions pour le back-office admin CarParts France.
 *
 * Deux rôles : owner (accès total) et employe (accès opérationnel).
 * Le owner dispose du wildcard '*' qui autorise toute ability.
 * L'employé a accès aux fonctions du quotidien mais PAS aux KPI
 * financiers, aux paramètres du site, à la facturation ni à la gestion d'équipe.
 */

const ROLES = {
  OWNER: 'owner',
  EMPLOYE: 'employe',
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
};

/**
 * Vérifie si un rôle possède une ability donnée.
 * @param {string} role - Le rôle de l'utilisateur ('owner' ou 'employe').
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

module.exports = {
  ROLES,
  ABILITIES,
  hasAbility,
  getRoleLabel,
  isOwner,
};
