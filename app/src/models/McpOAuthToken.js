const mongoose = require('mongoose');

/*
 * Autorisations OAuth du connecteur MCP (Claude) : codes d'autorisation,
 * jetons d'accès et jetons de rafraîchissement.
 *
 * Pourquoi en base : jusqu'ici ces jetons vivaient en mémoire (Map) et chaque
 * redémarrage du site (déploiement Render, redémarrage d'instance) les
 * effaçait. Claude perdait alors l'accès et il fallait reconnecter le
 * connecteur à la main.
 *
 * Le jeton lui-même n'est jamais stocké : seule son empreinte SHA-256 l'est.
 * Une copie de la base ne donne donc accès à rien.
 *
 * Les documents expirés sont effacés par MongoDB (index TTL sur `expiresAt`) ;
 * le code vérifie aussi l'expiration à chaque lecture, car l'effacement TTL
 * peut prendre jusqu'à une minute.
 */
const mcpOAuthTokenSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['code', 'access', 'refresh'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    clientId: { type: String, trim: true },
    // Code d'autorisation seulement : de quoi vérifier PKCE et la redirection.
    codeChallenge: { type: String },
    redirectUri: { type: String },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

mcpOAuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('McpOAuthToken', mcpOAuthTokenSchema);
