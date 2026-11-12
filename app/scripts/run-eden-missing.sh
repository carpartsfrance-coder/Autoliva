#!/usr/bin/env bash
# PHASE 3 — réfs Eden manquantes (393) : copie photos détourées → import → photos réelles
# (68) → transport → publication. PRÉREQUIS : avoir lancé le détourage
#   python ~/Documents/eden_build.py     (dans ton env rembg)
#   bash scripts/run-eden-missing.sh          -> DRY
#   bash scripts/run-eden-missing.sh apply    -> exécute
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"; cd "$APP_DIR"
N="$HOME/.nvm/versions/node/v22.12.0/bin/node"
JSON="scripts/boites_eden_missing.json"
FICHES="$HOME/Scrape/output/eden_fiches"
COPYMAP="$HOME/Scrape/output/eden_copymap.json"
MODE="${1:-dry}"
hr(){ printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

# copie les photos détourées IMG## -> dossiers {code} (idempotent, local)
hr "Copie photos détourées → dossiers code"
python3 - "$FICHES" "$COPYMAP" <<'PY'
import json,os,glob,shutil,sys
F,cmp=sys.argv[1],sys.argv[2]
cm=json.load(open(cmp)); n=0; miss=0
for code,img in cm.items():
    src=os.path.join(F,img)
    if not os.path.isdir(src) or not glob.glob(src+'/*.jpg'): miss+=1; continue
    dst=os.path.join(F,code); os.makedirs(dst,exist_ok=True)
    for p in sorted(glob.glob(src+'/*.jpg')): shutil.copy(p,os.path.join(dst,os.path.basename(p)))
    n+=1
print(f"  {n} codes photo prêts · {miss} sans détourage (relance eden_build.py ?)")
PY

if [ "$MODE" = "apply" ]; then
  hr "1/4 Import des 393 fiches Eden (template manuel par défaut)"
  BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js
  hr "2/4 Photos réelles Eden (68) — écrase le template sur ces codes"
  ACR_PHOTOS="$FICHES" SKU_PREFIX=EDN- MAX_PHOTOS=4 "$N" scripts/upload-acr-photos.js --overwrite
  hr "3/4 Transport échange standard"
  "$N" scripts/set-shipping-boites.js --apply
  hr "4/4 Publication des 393 EDN-"
  PUBLISH_PREFIX=EDN- BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --publish-all
  hr "Couverture Eden finale"
  "$N" scripts/_eden-coverage.js
else
  hr "DRY — import (aperçu)"
  BOITES_JSON="$JSON" "$N" scripts/import-boites-eden.js --dry-run | tail -4
  hr "DRY terminé — rien écrit. Détoure (python ~/Documents/eden_build.py) puis : bash scripts/run-eden-missing.sh apply"
fi
