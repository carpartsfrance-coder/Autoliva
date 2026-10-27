# Changelog

## 2026-10-27 — Désinscription réelle des relances + fin des relances après paiement

Déclencheur : un client (commande CP2026-000673) recevait des relances « votre panier vous attend » après avoir payé, et le lien « Se désinscrire des emails marketing » du pied de ces emails ne menait nulle part.

### Trois causes corrigées
1. **Lien de désinscription mort** : les 3 emails de relance panier et l'email de nouvel article pointaient vers `/newsletter/desinscription`, une route qui n'a jamais existé (404). Le client cliquait, rien ne se passait.
2. **Relances après paiement** : quand un client paie et ne revient pas sur le site, son panier reste dans sa session. Le CRON de détection le revoyait plus tard et créait un NOUVEAU lead, avec un `abandonedAt` postérieur à la commande — ce que le garde-fou « commande payée depuis l'abandon » ne pouvait pas voir. Résultat : 3 relances sur une pièce déjà achetée.
3. **Double confirmation de commande** : le retour du client et le webhook du prestataire de paiement arrivaient à une seconde d'écart et lisaient tous les deux un flag `orderConfirmationSentAt` encore vide → deux emails de confirmation.

### Nouveau
- Page publique `/desinscription` : lien signé (HMAC) en un clic depuis l'email, ou saisie manuelle de l'adresse (utile quand un client le demande par téléphone). `/newsletter/desinscription` redirige vers elle, pour les emails déjà partis.
- Collection `marketingoptouts` : une adresse désinscrite ne reçoit plus de relance panier, de relance devis, de newsletter ni de SMS marketing. La désinscription stoppe immédiatement les leads en cours et l'abonnement newsletter.
- Les emails **transactionnels** (confirmation, expédition, consigne, livraison, SAV, remboursement) ne sont jamais filtrés : ils restent dus au client.
- `src/services/cartReminderGuards.js` : garde-fou partagé entre la détection et l'envoi. Ne relance pas si le client a payé depuis l'abandon, ou s'il a acheté l'une des pièces du panier dans les 60 derniers jours (rattrape les paniers résiduels de session).
- Admin « Leads à relancer » : badge **Désinscrit** sur la carte du lead, bouton de relance désactivé, message clair si on tente quand même.

### Configuration
- Nouvelle variable optionnelle `UNSUBSCRIBE_TOKEN_SECRET` (cf. `app/.env.example`). Si elle est vide, `SESSION_SECRET` est utilisé — aucune action requise sur Render.

### Tests
- `app/tests/integration/marketing-optout.test.js` : rejoue le scénario complet sur une vraie base MongoDB et la vraie app Express (vues rendues par HTTP, `fetch` intercepté donc aucun email réel). Couvre le panier résiduel non relancé, le lien de désinscription, le token invalide, la redirection de l'ancien lien, la réinscription, et la non-régression (un vrai panier abandonné est toujours relancé).

### Fichiers ajoutés
- `app/src/models/MarketingOptOut.js`, `app/src/services/marketingOptOut.js`, `app/src/services/cartReminderGuards.js`
- `app/src/controllers/unsubscribeController.js`, `app/src/views/unsubscribe.ejs`
- `app/tests/integration/marketing-optout.test.js`

### Fichiers modifiés
- `app/src/routes/index.js`, `app/src/routes/newsletter.js`, `app/src/app.js` (CSRF sur `/desinscription`)
- `app/src/services/emailTemplates.js`, `app/src/services/emailService.js`, `app/src/services/engineQuoteEmail.js`, `app/src/services/smsService.js`
- `app/src/jobs/sendAbandonedCartReminders.js`, `app/src/jobs/detectAbandonedCarts.js`, `app/src/jobs/sendEngineQuoteReminders.js`
- `app/src/controllers/checkoutController.js` (verrou de confirmation), `app/src/controllers/abandonedCartAdminController.js`, `app/src/views/admin/cart-activity.ejs`
- `app/.env.example`

## 2026-10-12 — Connecteur MCP : les autorisations survivent aux redémarrages

### Backend
- **Correction** : les codes et jetons OAuth du connecteur (`/oauth/*`) vivaient en mémoire dans `app/src/mcp/oauth.js`. Chaque déploiement ou redémarrage Render les effaçait, et Claude perdait l'accès jusqu'à une reconnexion manuelle (constaté le 12/10 au matin, juste après la mise en ligne de la demande n° 429). Ils sont maintenant gardés dans MongoDB, nouveau modèle `McpOAuthToken`.
- Seule l'empreinte SHA-256 de chaque jeton est stockée : une copie de la base ne donne accès à rien.
- Expiration gérée par MongoDB (index TTL sur `expiresAt`) et vérifiée à chaque lecture. Codes : 5 min, à usage unique. Jetons d'accès : 30 jours. Jetons de rafraîchissement : 90 jours, remplacés à chaque usage (ils n'expiraient pas avant, mais disparaissaient au premier redémarrage).
- Base indisponible : le connecteur répond **503 + `Retry-After`** au lieu de 401, pour que Claude réessaie au lieu de jeter son autorisation. Sans jeton, la réponse reste 401 (Claude doit pouvoir découvrir la page de connexion). Le secret statique `MCP_BEARER_TOKEN` ne dépend pas de la base.
- Une signature de consentement de mauvaise longueur faisait lever `timingSafeEqual` : elle est maintenant refusée proprement (400), et les routes OAuth devenues asynchrones ont un filet qui empêche une requête malformée d'arrêter le processus.
- Aucune dépendance ajoutée, aucune variable d'environnement nouvelle. La collection `mcpoauthtokens` se crée seule.

### Tests
- `app/tests/integration/mcp-oauth-persistance.test.js` (10 cas) : parcours complet de Claude (consentement, code PKCE, jeton), **redémarrage simulé puis même jeton toujours accepté**, rafraîchissement à usage unique, code à usage unique, jeton expiré refusé, aucun jeton en clair en base, index TTL présent, signature malformée, base coupée (503 puis retour à la normale). Sur l'ancien code, le test du redémarrage échoue.

### Mise en service — côté Killian
1. Fusionner et laisser Render redéployer.
2. Reconnecter **une dernière fois** le connecteur dans Claude : les autorisations d'avant étaient en mémoire, ce déploiement les efface comme les précédents. Les suivants ne les toucheront plus.

## 2026-10-12 — Connecteur MCP : lecture du SAV et des commandes

### Backend
- **Nouveau** : quatre outils en **lecture seule** sur le connecteur MCP existant (`/mcp`) : `listSavTickets`, `getSavTicket`, `getSavAttachment`, `getOrder`. Documentation : [`app/src/mcp/README.md`](../app/src/mcp/README.md).
- `getSavAttachment` rend les photos (réduites à 1400 × 2400 px quand elles dépassent 2 Mo) et les pages JPEG d'un PDF scanné. Le texte d'un PDF n'est jamais lu : un PDF « texte » est annoncé illisible plutôt que deviné, un PDF mixte porte un avertissement.
- `services/savAgentService.js` : filtres ajoutés à la file (`open_only`, `awaiting`, `search`) et champs ajoutés à chaque ticket (`created_at`, `waiting_on`, dates du dernier message). Ajouts seulement : l'API « agent » (`/admin/api/sav/agent`) répond comme avant quand ces paramètres sont absents (vérifié par test).
- **Correction** dans cette même API : `?status[$ne]=x`, `?motif[...]`, `?team[...]` et `?assignee[...]` passaient tels quels dans la requête Mongo (injection d'opérateur, derrière la clé d'API). Seules les chaînes sont désormais acceptées.
- Aucune dépendance ajoutée, aucune variable d'environnement nouvelle, aucune migration.

### Sécurité
- Aucun outil n'écrit en base (vérifié par test : état de la base identique avant et après tous les appels).
- Pas de champ téléphone, adresse postale, prix d'achat, réponse brute de paiement ni contenu de fichier de commande dans les réponses. Les textes libres (messages, notes internes) sont rendus tels quels.
- `getSavAttachment` refuse tout fichier qui n'est pas rattaché au ticket nommé (autre ticket, fichier interne, identifiant inconnu : même réponse).
- **Fichiers piégés** (les pièces jointes viennent des clients) : aucun PDF n'est ouvert avec une bibliothèque, aucune image n'est décodée sans que ses dimensions aient été lues dans l'en-tête, la réduction se fait dans un fil séparé avec file d'attente et délai. Détail dans le README du connecteur.
- Connecteur : comparaison du jeton à temps constant, lot JSON-RPC plafonné à 10 messages, page d'autorisation OAuth mise à jour (elle annonce maintenant le SAV et les commandes).
- ⚠ Le jeton `MCP_BEARER_TOKEN` donne désormais accès à des données personnelles de clients. Le faire tourner s'il a circulé, et éviter la variante « jeton dans l'URL ».

### Tests
- `app/tests/integration/mcp-sav-lecture.test.js` (16 cas) et `app/tests/unit/mcp-sav-outils.test.js` (13 cas), dont : base identique avant et après tous les appels (fichiers compris), image de 12 000 × 12 000 px refusée sans allocation, PDF qui se dilaterait en 200 Mo lu sans rien décompresser, PDF de 4 Mo de flux vides lu en temps linéaire.

### Mise en service — côté Killian
1. Fusionner et laisser Render redéployer.
2. Vérifier que `MCP_BEARER_TOKEN` est bien renseigné sur Render (sinon le connecteur répond 503).
3. Ajouter (ou reconnecter) le connecteur `https://autoliva.com/mcp` dans Claude : les quatre nouveaux outils apparaissent.

## 2026-05-13 — API d'import blog server-to-server + refonte skill SEO en orchestrateur

### Backend
- **Nouveau** : endpoint `POST /api/blog/import-from-url` (Bearer auth, server-to-server). Permet à un orchestrateur d'importer un BlogPost à partir d'une URL pointant vers un fichier markdown + métadonnées JSON. Documentation : [`docs/blog-import-api.md`](./blog-import-api.md).
- **Refacto** : logique métier de création/upsert de BlogPost extraite dans `src/services/blogPostService.js` (DRY entre form admin et API import). Aucune régression sur le form HTML `POST /admin/blog/nouveau`.
- **Tests** : 10 cas d'intégration ajoutés dans `app/tests/integration/blog-import.test.js`. Lancer via `npm test` (utilise `node --test`, pas de framework externe). Test runner natif Node 18+, fixtures HTTP locales auto-démarrées.

### Sécurité
- Protection **SSRF** sur l'endpoint d'import : rejette les URLs vers hôtes privés (`127.x`, `10.x`, `192.168.x`, etc.) avec anti-DNS-rebinding par résolution serveur. HTTPS obligatoire en prod.
- Auth Bearer avec comparaison à **temps constant** (`crypto.timingSafeEqual`).
- Limites : markdown max 200 KB, body JSON max 256 KB, timeout fetch 15s.

### Configuration
- Nouvelle variable d'env : `BLOG_IMPORT_API_TOKEN` (cf. `app/.env.example`). Génération : `openssl rand -hex 32`.
- Sur Render : ajouter la variable dans le service web `car-parts-france-fr-refonte` puis redémarrer.

### Skill SEO (`~/.claude/skills/generateur-article-seo/SKILL.md`)
- **Refonte** : ajout du **mode orchestrateur** pour générer N cocons en parallèle via sous-agents `Task`. L'orchestrateur expose les markdowns via tunnel cloudflared puis appelle l'API import-from-url. Coût contexte des sous-agents réduit (pas de markdown 12-20 Ko dans les commandes JS).
- Mode interactif (1 cocon par conversation) inchangé — continue d'utiliser la méthode form classique.
- Anciennes sections "Mode autonome" remplacées par "Mode orchestrateur" avec workflow détaillé (étapes A à E), variables d'env requises, anti-patterns.

### Fichiers ajoutés
- `app/src/services/blogPostService.js`
- `app/src/routes/api/blogImport.js`
- `app/tests/integration/blog-import.test.js`
- `docs/blog-import-api.md`
- `docs/CHANGELOG.md`

### Fichiers modifiés
- `app/src/app.js` — montage du router `/api/blog`
- `app/src/controllers/blogAdminController.js` — délégation au service
- `app/.env.example` — ajout `BLOG_IMPORT_API_TOKEN` + `SAV_API_TOKEN`
- `app/package.json` — script `npm test`
- Skill `generateur-article-seo/SKILL.md` (hors repo, dans `~/Library/Application Support/Claude/...`)

### Migration
Aucune migration de données nécessaire. Le déploiement consiste à :
1. Merger la PR sur main → Render redéploie automatiquement
2. Ajouter `BLOG_IMPORT_API_TOKEN` dans l'env Render → restart
3. Mettre à jour l'env du scheduled task SEO Cowork avec la même valeur
