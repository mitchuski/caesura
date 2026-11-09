#!/usr/bin/env node
// owner.mjs — the person's door. Owner-only calls on the gate, signed with the owner's key.
//
//   node tools/owner.mjs pause   --owner caesura.testnet --gate gate.caesura.testnet
//   node tools/owner.mjs resume  --owner caesura.testnet --gate gate.caesura.testnet
//   node tools/owner.mjs policy  --owner caesura.testnet --gate gate.caesura.testnet --policy tasks/policy.json
//   node tools/owner.mjs state   --gate gate.caesura.testnet
//
// Owner credentials: ~/.near-credentials/<network>/<owner>.json (near-cli-rs legacy keychain).

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ownerAccount, gate } from '../lib/chain.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const network = opt('network', 'testnet')
const gateId = opt('gate', process.env.CAESURA_GATE)
if (!cmd || !gateId) { console.error('usage: node tools/owner.mjs pause|resume|policy|state --gate <gate> [--owner <owner>]'); process.exit(1) }

if (cmd === 'state') {
  const s = await gate.state(gateId, network)
  console.log(JSON.stringify(s, null, 2)); process.exit(0)
}
const ownerId = opt('owner'); if (!ownerId) { console.error('--owner is required'); process.exit(1) }
const credPath = join(homedir(), '.near-credentials', network, ownerId + '.json')
if (!existsSync(credPath)) { console.error('no credentials at ' + credPath); process.exit(1) }
const owner = ownerAccount(ownerId, JSON.parse(readFileSync(credPath, 'utf8')).private_key, network)

let r
if (cmd === 'pause') r = await gate.setPaused(owner, gateId, true)
else if (cmd === 'resume') r = await gate.setPaused(owner, gateId, false)
else if (cmd === 'policy') {
  const p = JSON.parse(readFileSync(opt('policy', 'tasks/policy.json'), 'utf8'))
  const NEAR = 10n ** 24n; const yocto = (n) => (BigInt(Math.round(n * 1e6)) * NEAR / 1_000_000n).toString()
  r = await gate.setPolicy(owner, gateId, { max_per_action: yocto(p.max_per_action_near), max_per_day: yocto(p.max_per_day_near), cooldown_ms: p.cooldown_ms, receivers: p.receivers, methods: p.methods })
} else { console.error('unknown: ' + cmd); process.exit(1) }
if (r.failure) { console.error(JSON.stringify(r.failure)); process.exit(2) }
console.log(`${cmd} · tx ${r.txHash}`)
for (const l of r.logs) if (l.startsWith('EVENT_JSON:')) console.log('  ' + l.slice(11))
