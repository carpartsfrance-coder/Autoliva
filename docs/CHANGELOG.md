# Changelog

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
