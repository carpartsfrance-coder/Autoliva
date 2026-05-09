# MCP Business Analytics — Car Parts France

Serveur MCP (Model Context Protocol) qui expose les données business de Car Parts France à un client MCP comme Claude Cowork. Lecture seule, monté sur le même Express que le site, partage la connexion Mongo.

## Endpoint

- URL : `https://<ton-domaine>/mcp` (override via `MCP_PATH`)
- Transport : Streamable HTTP, mode stateless (pas de session, JSON simple, pas de SSE)
- Auth : `Authorization: Bearer <MCP_BEARER_TOKEN>` obligatoire sur toutes les méthodes

## Variables d'env

- `MCP_BEARER_TOKEN` — secret partagé. Si absent, le serveur répond `503` à toutes les requêtes (fail closed).
- `MCP_PATH` — optionnel, défaut `/mcp`.

Génère un token costaud :
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Mets-le dans Render (Dashboard → Environment → `MCP_BEARER_TOKEN`).

## Outils exposés

| Outil | Question type |
|---|---|
| `getBusinessOverview` | "comment va le business sur 30j ? CA, AOV, mix sources, top 5 produits, paniers perdus" |
| `getProductPerformance` | "top produits par CA / par taux de retour, produits qui ne se vendent plus" |
| `getCampaignPerformance` | "quelles campagnes performent, paid vs SEO, last vs first touch" |
| `getFunnelLeaks` | "où je perds de l'argent : paniers abandonnés, produits à fort taux de retour" |

Période acceptée pour tous : `7d`, `30d`, `90d`, `365d`, `all`. Tous les montants sont retournés en euros.

## Brancher dans Claude Cowork

Cowork accepte les MCP servers HTTP via la config workspace. Ajoute :

```json
{
  "mcpServers": {
    "cpf-analytics": {
      "type": "http",
      "url": "https://<ton-domaine>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_BEARER_TOKEN>"
      }
    }
  }
}
```

Une fois connecté, demande-lui par exemple :
- "Compare le CA 30j vs 30j précédents et donne-moi 3 leviers actionnables"
- "Quels produits ont un taux de retour > 10% sur 90j ?"
- "Top 10 paniers abandonnés en valeur — propose une stratégie de relance"
- "Mes campagnes Google Ads convertissent-elles mieux que mon SEO ?"

## Test rapide en local

Une fois `MCP_BEARER_TOKEN=test123 npm start` lancé :

```bash
# tools/list
curl -s -X POST http://localhost:3000/mcp \
  -H "content-type: application/json" \
  -H "authorization: Bearer test123" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq

# vue de pilotage 30j
curl -s -X POST http://localhost:3000/mcp \
  -H "content-type: application/json" \
  -H "authorization: Bearer test123" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"getBusinessOverview","arguments":{"period":"30d"}}}' | jq
```

## Sécurité

- Lecture seule : aucun outil n'écrit en base.
- Auth Bearer obligatoire, fail closed si le token n'est pas configuré.
- Pas de session → pas d'état à compromettre côté serveur.
- Le token doit être traité comme une clé d'API : ne pas le committer, le faire tourner si compromis.

## Architecture

```
app/src/mcp/
├── server.js              # JSON-RPC dispatcher + auth Bearer + mountMcp(app)
├── tools/
│   ├── businessOverview.js
│   ├── productPerformance.js
│   ├── campaignPerformance.js  # réutilise services/marketingAggregations.js
│   └── funnelLeaks.js
└── util/
    ├── period.js          # parsing période + range période précédente
    └── format.js          # cents→euros, %, deltas, jsonResult helper
```

Pas de dépendance externe ajoutée : le protocole MCP est implémenté à la main (4 méthodes + ping suffisent en mode stateless).
