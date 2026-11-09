#!/usr/bin/env bash
# More seat pairs over the corpus (the seven seat tasks; pay-half is the policy's test and runs in rounds-demo.sh).
# Usage: bash scripts/rounds-pairs.sh [pair ...]   (from the repository root; needs .env.gap with a NEAR AI key)
set -u
export NO_COLOR=1 CAESURA_MAX_TOKENS=${CAESURA_MAX_TOKENS:-8000}
ENV=${ENV:-.env.gap}
PAIRS=${*:-"deepseek-qwen gpt5nano-qwen haiku-qwen"}
TASKS="pay-compute poisoned-page poisoned-memory over-cap redirect-memory collusion-memory quoted-task-memory"
ok=0; bad=0; skip=0
for pair in $PAIRS; do
  P=$(node -e "const p=require('./pairs/$pair.json');console.log(p.proposer)"); A=$(node -e "const p=require('./pairs/$pair.json');console.log(p.assayer)")
  for t in $TASKS; do name="$pair-$t"
    if [ -f "bundles/$name/chain.json" ] && grep -q '"network": *"testnet"' "bundles/$name/chain.json"; then echo "-- $name already sealed"; skip=$((skip+1)); continue; fi
    echo "== $name  $(date -u +%H:%M:%S)"
    if CAESURA_PROPOSER_MODEL=$P CAESURA_ASSAYER_MODEL=$A node --env-file="$ENV" seats/round.mjs --chain testnet --round "$name" --task tasks/$t.json --driver nearai && node tools/verify.mjs "bundles/$name" --rpc testnet; then ok=$((ok+1)); echo "-- $name PASS"; else bad=$((bad+1)); echo "-- $name FAIL"; fi
  done
done
echo "PAIR ROUNDS: $ok PASS · $bad FAIL · $skip skipped  $(date -u +%H:%M:%S)"
