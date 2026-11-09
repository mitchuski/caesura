#!/usr/bin/env bash
# The demonstration rounds on the first gate (pause.caesura.testnet, .env.caesura).
# Each round is minted, then verified from the bundle alone and against the chain.
# Usage: bash scripts/rounds-demo.sh  (from the repository root; needs .env.caesura and keys/)
set -u
export NO_COLOR=1
ENV=${ENV:-.env.caesura}
GATE=$(grep '^CAESURA_GATE=' "$ENV" | cut -d= -f2)
OWNER=${OWNER:-caesura.testnet}
LOG=${LOG:-bundles/.demo.log}
ok=0; bad=0
R() { local name=$1; shift
  echo "== $name  $(date -u +%H:%M:%S)"
  if node --env-file="$ENV" seats/round.mjs --chain testnet --round "$name" "$@" && node tools/verify.mjs "bundles/$name" --rpc testnet; then ok=$((ok+1)); echo "-- $name PASS"; else bad=$((bad+1)); echo "-- $name FAIL"; fi
}
R pay-compute               --task tasks/pay-compute.json      --driver nearai
R poisoned-page             --task tasks/poisoned-page.json    --driver nearai
R poisoned-memory           --task tasks/poisoned-memory.json  --driver nearai
R quoted-task-memory        --task tasks/quoted-task-memory.json --driver nearai
R over-cap                  --task tasks/over-cap.json         --driver stub
R poisoned-page-naive-assayer --task tasks/poisoned-page.json  --driver stub --assayer naive
R signed-pay-compute        --task tasks/pay-compute.json      --driver nearai --sign keys/seats.json
# a seat moves suite: both seats composite, a transfer ceremony countersigned by the keys it leaves
node --env-file="$ENV" tools/keys.mjs gen --policy tasks/keys-both.json --out keys/seats-both.json
node tools/keys.mjs ceremony --keys keys/seats-both.json --owner keys/owner.json --previous keys/ceremony.json --previous-keys keys/seats.json --out keys/ceremony-both.json
R transfer-redirect-memory  --task tasks/redirect-memory.json  --driver nearai --sign keys/seats-both.json --ceremony keys/ceremony-both.json
R pay-compute-while-paused  --task tasks/pay-compute.json      --driver stub --mid-owner pause
node tools/owner.mjs resume --owner "$OWNER" --gate "$GATE"
R policy-changed-mid-round  --task tasks/pay-compute.json      --driver stub --mid-owner policy:tasks/policy-no-compute.json
node tools/owner.mjs policy --owner "$OWNER" --gate "$GATE" --policy tasks/policy.json
R salami-1 --task tasks/pay-half.json --driver stub
R salami-2 --task tasks/pay-half.json --driver stub
R salami-3 --task tasks/pay-half.json --driver stub
R salami-4 --task tasks/pay-half.json --driver stub
echo "== key-scope abuse"
node --env-file="$ENV" tools/abuse.mjs --out bundles/key-scope && echo "-- key-scope done"
echo "DEMO ROUNDS: $ok PASS · $bad FAIL  $(date -u +%H:%M:%S)"
