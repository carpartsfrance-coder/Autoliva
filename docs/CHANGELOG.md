# Changelog

## 2026-11-11 — SEO : pages des familles prioritaires et liens depuis le blog

Audit SEO du 11/11/2026 (problèmes 4 et 8). S'applique après « titres sans « … », anciennes catégories redirigées, pages 2+ ouvertes » (même date).

### Backend
- **Pages catégorie des trois familles prioritaires** (`/categorie/ponts-differentiels`, `/categorie/boites-de-transfert`, `/categorie/mecatroniques`) : title et description écrits pour la recherche (« Pont arrière et différentiel reconditionnés | Autoliva », « Boîtes de transfert reconditionnées BMW, Mercedes, Porsche », « Mécatronique DSG et calculateur de boîte reconditionnés »), H1 avec « reconditionnés », texte d'introduction (reconditionnement, marques couvertes, comment trouver la bonne pièce), boutons vers le devis, et FAQ de 5 questions avec ses données FAQPage. Introduction et FAQ en page 1 seulement. Avant : « Ponts & différentiels - Pièces auto », un H1 nu, puis la grille.
- Le texte vit dans `data/seo/pages-familles.json` (lu par `services/pagesFamilles.js`), pas en base : il est relu par un test avant chaque mise en ligne. Mêmes règles que `claims-policy.json` : ni ISO 9001, ni « notre atelier », ni durée de garantie générale (« indiquée sur chaque fiche »), ni paiement en plusieurs fois, ni délai promis. Français seulement (la couche allemande est hors de Google).
- Les titles des catégories ne copient pas ceux des pages de devis `/ponts-differentiels` et `/boites-de-transfert` (landings Ads, inchangées) : la catégorie vise « reconditionné » et les marques, la page de devis « échange standard ».
- **Blog → familles** : chaque article d'une famille prioritaire (catégorie de l'article, sinon son titre : DQ200, ATC, différentiel…) se termine par un lien vers sa page catégorie (« Voir tous nos ponts et différentiels reconditionnés »…). Sur 40 articles relus, un seul faisait ce lien.

### Frontend
- `products/index.ejs` : sur mobile, seul le premier paragraphe de l'introduction s'affiche, la suite derrière « Lire la suite » (sans JavaScript), pour garder les produits près du haut de l'écran. Sur ordinateur, tout le texte est visible.
- `blog/show.ejs` : lien de famille entre le texte et l'encart de fin d'article.

### Tests
- `tests/unit/pages-familles.test.js` (8 cas) : longueurs (title ≤ 60 servi tel quel, description 120–160, introduction 80–250 mots), allégations interdites, liens, FAQPage, français seulement, famille d'un article.
- `tests/integration/audit-seo-novembre.test.js` : 2 cas de plus sur la vraie application (catégorie « ponts » page 1 et page 2, lien de fin d'article).
- `tests/fixtures/seo/rendu-avant-politique.json.gz` réenregistré : 3 pages différentes, toutes voulues — le title et les 2 boutons de `/categorie/boites-de-transfert`, le lien de famille de 2 articles (DQ200, boîte de transfert Audi Q3).

### Mise en service
- Aucune variable d'environnement nouvelle, aucune migration. Après la mise en ligne : demander l'indexation des trois catégories dans la Search Console.

## 2026-11-11 — SEO : titres sans « … », anciennes catégories redirigées, pages 2+ ouvertes

Audit SEO du 11/11/2026 (problèmes 2, 5 et 6, consigne 8).

### Backend
- **Titres sans « … »** : nouvelle règle commune `services/titreSeo.js`, utilisée par les fiches, le blog, les catégories et les pages véhicule. Le titre est coupé entre deux mots, jamais au milieu, sans « … » ; la référence de la pièce (2462800200, CV6W-4000-DB…), les codes défaut (P17BF) et le code écrit après « — » (code boîte HNE) ne sont jamais coupés. Sur une fiche, « | Autoliva » saute plutôt que le texte ; sur un article, il reste tant que le texte coupé reste parlant. « échange standard » ne saute que s'il faut gagner de la place. Avant : 8 fiches sur 10 testées perdaient leur référence.
- **Anciennes adresses de catégories** : `/categorie/transmission-pont-differentiel`, `-mecatronique`, `-boite-de-transfert`, `-boite-de-vitesses` et 11 autres répondaient 404 (15 relevées dans la Search Console). Elles répondent maintenant 301 vers la catégorie qui les remplace (`data/seo/redirections-categories.json`, `services/redirectionsCategories.js`), y compris avec une queue parasite et sous `/de`. Une cible absente ou désactivée n'est jamais servie (404 conservé). Même règle pour le segment catégorie des pages `/pieces-auto/<marque>/<modèle>/<catégorie>`.
- **Renommer une catégorie dans l'admin** garde l'ancien slug (`Category.slugAliases`) : l'ancienne adresse redirige automatiquement. Correction au passage : le texte SEO d'une catégorie ne s'enregistrait pas quand il était le seul champ modifié.
- **Pages 2 et suivantes des catégories indexables** : canonique sur elles-mêmes (déjà le cas), « – page N » dans le title et la description, hreflang sur elles-mêmes. Avant, 316 des 340 ponts n'étaient listés que sur des pages en noindex. Un filtre au-delà de la catégorie (tri, prix, véhicule…) garde le noindex.
- Pages 404 et 500 en « noindex, follow » (elles disaient « index, follow »). `robots.txt` ne cite plus `/_next/` (le site n'utilise pas Next.js).

### Tests
- `tests/unit/titres-seo.test.js` (10 cas, titres réels du site), `tests/unit/redirections-categories.test.js` (5 cas), `tests/integration/audit-seo-novembre.test.js` (5 cas sur la vraie application : 301, 404 noindex, page 2, titre de fiche, robots.txt).
- `tests/fixtures/seo/rendu-avant-politique.json.gz` réenregistré (SEO_PRUNE absent) : 10 différences, toutes voulues — 6 titres sans « … », la ligne `/_next/` de robots.txt, et la balise robots de 3 pages 404.

### Mise en service
- Aucune variable d'environnement nouvelle, aucune migration. Le champ `slugAliases` naît vide.

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
