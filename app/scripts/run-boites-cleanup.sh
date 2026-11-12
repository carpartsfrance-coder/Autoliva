#!/usr/bin/env bash
# Remise en cohérence du catalogue boîtes de vitesses.
#   bash scripts/run-boites-cleanup.sh          -> DRY (prévisualise, n'écrit rien)
#   bash scripts/run-boites-cleanup.sh apply    -> exécute tout dans l'ordre
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"; cd "$APP_DIR"
N="$HOME/.nvm/versions/node/v22.12.0/bin/node"
JSON="scripts/boites_dekram.json"
PHOTOS="$HOME/Scrape/output/dekram_fiches"
MODE="${1:-dry}"

hr(){ printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

if [ "$MODE" = "apply" ]; then
  hr "1/8 Purge orphelins DEK (doublons internes de code)"
  PUBLISH_PREFIX=DEK- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --purge-orphans
  hr "2/8 Ré-import des 968 (titres propres, compat fusionnée, photos préservées)"
  BOITES_JSON="$JSON" NO_TEMPLATE=1 "$N" scripts/import-boites-eden.js
  hr "3/8 Photos des nouvelles références"
  ACR_PHOTOS="$PHOTOS" SKU_PREFIX=DEK- MAX_PHOTOS=4 "$N" scripts/upload-acr-photos.js
  hr "4/8 Publication des 968 DEK"
  PUBLISH_PREFIX=DEK- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --publish-all
  hr "5/8 Dé-publication des 200 ALV-BX (template, sans reconditionnée)"
  PUBLISH_PREFIX=ALV-BX- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --unpublish-all
  hr "6/8 Dé-publication des ASY dont le code est couvert par Dekram"
  WINNER_PREFIX=DEK- LOSER_PREFIX=ASY- "$N" scripts/_dedup-cross-source.js --apply
  hr "7/8 Classe transport échange standard"
  "$N" scripts/set-shipping-boites.js --apply
  hr "8/8 Ré-audit de contrôle"
  "$N" scripts/_audit-boites.js
  hr "TERMINÉ"
else
  hr "DRY 1 — orphelins DEK à purger"
  PUBLISH_PREFIX=DEK- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --purge-orphans --dry-run
  hr "DRY 2 — ALV-BX à dé-publier"
  PUBLISH_PREFIX=ALV-BX- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --unpublish-all --dry-run
  hr "DRY 3 — ASY couverts par DEK (approx : DEK encore à 1320 avant ré-import)"
  WINNER_PREFIX=DEK- LOSER_PREFIX=ASY- "$N" scripts/_dedup-cross-source.js
  hr "DRY terminé — rien écrit. Pour exécuter : bash scripts/run-boites-cleanup.sh apply"
fi
