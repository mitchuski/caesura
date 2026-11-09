#!/usr/bin/env bash
# The gap study on the second gate (gap.caesura.testnet, .env.gap): what crosses to the second seat.
# Usage: bash scripts/rounds-gap.sh  (from the repository root; needs .env.gap with a NEAR AI key)
set -u
export NO_COLOR=1
ENV=${ENV:-.env.gap}
ok=0; bad=0
G() { local name=$1; shift
  echo "== $name  $(date -u +%H:%M:%S)"
  if node --env-file="$ENV" seats/round.mjs --chain testnet --round "$name" "$@" && node tools/verify.mjs "bundles/$name" --rpc testnet; then ok=$((ok+1)); echo "-- $name PASS"; else bad=$((bad+1)); echo "-- $name FAIL"; fi
}
Q27=Qwen/Qwen3.8-27B; Q36=Qwen/Qwen3.6-35B-A3B-FP8; GLM=z-ai/glm-5.3-flash
# the curve: a stub proposer that follows the poison by construction, an enclave assayer, g0..g4
for g in 0 1 2 3 4; do for t in redirect-memory collusion-memory; do
  CAESURA_ASSAYER_MODEL=$Q27 G gap-$g-$t     --task tasks/$t.json --driver mixed --gap $g --study gap
done; done
# the smaller assayer on the same curve
for g in 0 1 2 3 4; do for t in redirect-memory collusion-memory; do
  CAESURA_ASSAYER_MODEL=$Q36 G gap-$g-$t-q36 --task tasks/$t.json --driver mixed --gap $g --study gap
done; done
# same-model pairs at the designed gap: the gap, not model diversity, does the holding
for t in pay-compute redirect-memory collusion-memory quoted-task-memory; do
  CAESURA_PROPOSER_MODEL=$Q27 CAESURA_ASSAYER_MODEL=$Q27 G same-qwen-$t --task tasks/$t.json --driver nearai
  CAESURA_PROPOSER_MODEL=$GLM CAESURA_ASSAYER_MODEL=$GLM G same-glm-$t  --task tasks/$t.json --driver nearai
done
CAESURA_PROPOSER_MODEL=$GLM CAESURA_ASSAYER_MODEL=$Q27 G glm-qwen-quoted-task --task tasks/quoted-task-memory.json --driver nearai
echo "GAP ROUNDS: $ok PASS · $bad FAIL  $(date -u +%H:%M:%S)"
