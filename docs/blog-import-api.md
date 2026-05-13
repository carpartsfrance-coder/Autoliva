# API Blog Import — `POST /api/blog/import-from-url`

Endpoint server-to-server pour publier un BlogPost à partir d'une URL pointant vers un fichier markdown + métadonnées JSON.

**Cas d'usage principal** : scheduled task SEO orchestrant N sous-agents Claude qui publient chacun leur cocon (5 articles). Le markdown n'est pas embarqué dans la requête — il est exposé via une URL publique (tunnel cloudflared / serveur HTTP local) puis fetché par le serveur. Cela réduit drastiquement le coût contexte des agents.

---

## Endpoint

```
POST /api/blog/import-from-url
Authorization: Bearer <BLOG_IMPORT_API_TOKEN>
Content-Type: application/json
```

### Body

```jsonc
{
  "markdownUrl": "https://abc-123.trycloudflare.com/cocoon/pilier.md",
  "metadata": {
    "title": "Titre H1 de l'article",            // REQUIS, ≤ 200 char
    "slug": "slug-optimise-seo",                  // REQUIS, regex [a-z0-9-]+, ≤ 150 char
    "excerpt": "Résumé 2-3 phrases.",
    "coverImageUrl": "/media/650abc...",          // chemin relatif (pas d'URL absolue)
    "authorName": "Expert CarParts",
    "readingTimeMinutes": 12,
    "relatedProductIds": ["650def..."],           // array d'ObjectId Mongoose valides
    "isPublished": true,
    "publishedAt": "2026-05-13",                  // YYYY-MM-DD ou ISO 8601
    "category": {
      "label": "Transmission > Mécatronique",
      "slug": "transmission-mecatronique"
    },
    "seo": {
      "primaryKeyword": "mécatronique DSG6 DQ250",
      "metaTitle": "Title tag 50-65 caractères",  // warn si hors plage, ne bloque pas
      "metaDescription": "Meta 120-165 caractères avec CTA.", // warn idem
      "metaRobots": "index, follow",
      "ogImageUrl": "/media/650abc...",
      "canonicalPath": "/blog/slug-optimise-seo"
    }
  },
  "mode": "create"                                // "create" (défaut) | "upsert"
}
```

### Réponses

| Code | Cas | Body |
|---|---|---|
| `201` | Article créé (mode `create`) | `{ success: true, data: { id, slug, url, created: true, ... } }` |
| `200` | Article mis à jour (mode `upsert` sur slug existant) | `{ success: true, data: { id, slug, url, updated: true, ... } }` |
| `400` | Validation (slug invalide, IP privée, markdown trop grand, etc.) | `{ success: false, error: "...", details: {...} }` |
| `401` | Token absent ou invalide | `{ success: false, error: "Non autorisé..." }` |
| `409` | Slug déjà existant (mode `create` uniquement) | `{ success: false, error: "...", details: { slug } }` |
| `502` | Fetch du markdown a échoué (timeout, 404, erreur réseau) | `{ success: false, error: "...", details: { upstreamStatus } }` |
| `500` | Erreur serveur interne | `{ success: false, error: "Erreur serveur interne." }` |

---

## Sécurité

### Authentification — Bearer token
- Header `Authorization: Bearer <token>` obligatoire
- Token chargé depuis l'env `BLOG_IMPORT_API_TOKEN`
- Comparaison à **temps constant** (`crypto.timingSafeEqual`) pour éviter le timing-attack
- Si la variable d'env n'est pas définie côté serveur → réponse `500` (failure-closed)

### Protection SSRF
L'endpoint refuse de fetcher des URLs vers :
- des hôtes privés : `localhost`, `127.x`, `10.x`, `192.168.x`, `169.254.x`, `0.x`, IPv6 link-local/ULA
- des hostnames qui **résolvent** vers une IP privée (anti-DNS-rebinding via `dns.lookup`)
- des protocoles ≠ `https:` (sauf `http:` accepté uniquement en `NODE_ENV !== 'production'`)

### Limites
- Markdown max : **200 KB** (rejette `400` si `Content-Length` ou le buffering dépasse)
- Timeout fetch : **15 secondes** (`AbortController`)
- Body JSON max : **256 KB** (limite `express.json({ limit: '256kb' })`)
- User-Agent fixé : `CarPartsFrance-BlogImporter/1.0`

---

## Génération et déploiement du `BLOG_IMPORT_API_TOKEN`

### 1. Génération locale

```bash
openssl rand -hex 32
# Exemple : f4a8b9c2d6e1f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8
```

### 2. Sur Render

1. Dashboard Render → service `car-parts-france-fr-refonte` → **Environment**
2. Ajouter une variable :
   - **Key** : `BLOG_IMPORT_API_TOKEN`
   - **Value** : la valeur générée
3. **Save Changes** → Render redémarre automatiquement le service

### 3. Choix de l'`ADMIN_BASE_URL`

L'endpoint est accessible sur **tous les domaines** pointant sur le service (même app, même DB) :

| URL | Quand l'utiliser |
|---|---|
| `https://autoliva.com` | **Recommandé** — domaine canonique prod, stable, ne dépend pas du nom du service Render |
| `https://carpartsfrance.fr` | Équivalent (ancien domaine, même service, même DB) |
| `https://preprod.carpartsfrance.fr` | Tests sur l'env preprod |
| `https://car-parts-france-fr-refonte.onrender.com` | URL Render technique — fonctionne mais change si on renomme le service |

### 4. Côté orchestrateur (scheduled task)

Stocker le token + l'URL dans l'env du scheduled task :

```bash
export BLOG_IMPORT_API_TOKEN="..."
export ADMIN_BASE_URL="https://autoliva.com"
```

Et le passer aux sous-agents Claude via le prompt (cf. `~/.claude/skills/generateur-article-seo/SKILL.md` section "Mode orchestrateur").

### 4. Rotation

Pour rotater le token sans downtime :
1. Générer un nouveau token
2. Le mettre dans Render (Save → restart service)
3. Mettre à jour l'env du scheduled task
4. Les anciennes invocations vont 401 jusqu'à ce que le scheduled task se relance

---

## Exemple `curl` complet

```bash
# 1. Préparer le markdown sur un serveur public (ou tunnel cloudflared)
echo "# Titre\n\nContenu..." > /tmp/test-article.md
cd /tmp && python3 -m http.server 8765 &
TUNNEL_URL=$(cloudflared tunnel --url http://localhost:8765 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)

# 2. Appeler l'endpoint
curl -sS -X POST "$ADMIN_BASE_URL/api/blog/import-from-url" \
  -H "Authorization: Bearer $BLOG_IMPORT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<EOF | jq .
{
  "markdownUrl": "$TUNNEL_URL/test-article.md",
  "metadata": {
    "title": "Article de test API import",
    "slug": "article-test-api-import",
    "excerpt": "Test de l'endpoint d'import depuis URL.",
    "coverImageUrl": "/media/650abc1234567890abcdef00",
    "authorName": "Expert CarParts",
    "readingTimeMinutes": 5,
    "relatedProductIds": [],
    "isPublished": true,
    "publishedAt": "$(date +%Y-%m-%d)",
    "category": { "label": "Transmission > Test", "slug": "transmission-test" },
    "seo": {
      "primaryKeyword": "article test API",
      "metaTitle": "Article de test API import — guide complet",
      "metaDescription": "Description de test suffisamment longue pour respecter les bonnes pratiques SEO sur la meta.",
      "metaRobots": "index, follow"
    }
  },
  "mode": "create"
}
EOF
```

**Réponse 201 attendue** :
```json
{
  "success": true,
  "data": {
    "id": "6a04...",
    "slug": "article-test-api-import",
    "url": "https://autoliva.com/blog/article-test-api-import",
    "created": true,
    "updated": false,
    "isPublished": true,
    "warnings": []
  }
}
```

---

## Tests d'intégration

10 cas couverts dans `app/tests/integration/blog-import.test.js`. Lancer :

```bash
cd app
MONGODB_URI=mongodb://... npm test
```

Les tests se connectent à la DB fournie via `TEST_MONGODB_URI` (ou `MONGODB_URI` en fallback) et nettoient les BlogPost créés à la fin. Si aucune DB n'est configurée, les tests qui requièrent la DB sont skippés.

---

## Logs et audit

- Logs HTTP : `logs/blog-import-api.log` (format `ISO METHOD URL STATUS`)
- Audit en base : collection `auditlogs` avec `action: 'blog.import-from-url'`, `entityType: 'blog_post'`, payload `after` contenant `slug`, `mode`, `markdownUrl`, `markdownBytes`, `tokenId` (8 premiers chars du token utilisé)

---

## Lien avec le skill SEO

Le skill `generateur-article-seo` (~/.claude/skills/...) consomme cet endpoint en mode orchestrateur — voir la section "Mode orchestrateur" du SKILL.md pour le workflow complet (queue, sous-agents Task, tunnel cloudflared, maillage inter-cocons).
