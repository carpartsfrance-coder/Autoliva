#!/usr/bin/env bash
# PHASE 2 — largeur Eden : republie les ALV-BX (nettoyées) pour les codes qu'aucune
# source qualité (DEK/ASY) ne couvre. À lancer APRÈS run-boites-cleanup.sh apply.
#   bash scripts/run-eden-breadth.sh          -> DRY
#   bash scripts/run-eden-breadth.sh apply    -> exécute
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"; cd "$APP_DIR"
N="$HOME/.nvm/versions/node/v22.12.0/bin/node"
JSON="scripts/boites_manuelles_clean.json"
MODE="${1:-dry}"
hr(){ printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

if [ ! -f "$JSON" ]; then echo "❌ $JSON manquant (lance d'abord la génération)."; exit 1; fi

if [ "$MODE" = "apply" ]; then
  hr "1/4 Purge des ALV-BX orphelines (doublons de code d'avant dédup)"
  PUBLISH_PREFIX=ALV-BX- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --purge-orphans
  hr "2/4 Ré-import ALV-BX nettoyées (titres « reconditionnée », photos template préservées)"
  BOITES_JSON="$JSON" NO_TEMPLATE=1 "$N" scripts/import-boites-eden.js
  hr "3/4 Publication ciblée : ALV-BX qui comblent un trou Eden (jamais un code déjà couvert)"
  "$N" scripts/_republish-alvbx-gaps.js --apply
  hr "4/4 Couverture Eden après largeur"
  "$N" scripts/_eden-coverage.js
  hr "TERMINÉ"
else
  hr "DRY 1 — ALV-BX orphelines à purger"
  PUBLISH_PREFIX=ALV-BX- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --purge-orphans --dry-run
  hr "DRY 2 — ré-import ALV-BX (aperçu)"
  BOITES_JSON="$JSON" NO_TEMPLATE=1 "$N" scripts/import-boites-eden.js --dry-run | tail -3
  hr "DRY 3 — ALV-BX à publier pour combler Eden"
  "$N" scripts/_republish-alvbx-gaps.js
  hr "DRY terminé — rien écrit. Pour exécuter : bash scripts/run-eden-breadth.sh apply"
fi
