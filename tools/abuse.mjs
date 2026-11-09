#!/usr/bin/env node
// abuse.mjs — try to misuse the seat keys and record what the protocol and the gate say.
//
//   node --env-file=.env.caesura tools/abuse.mjs [--out bundles/key-scope]
//
// 1. the proposer key calls `assay`            → the protocol refuses: the key is scoped to propose
// 2. the assayer key calls `propose`           → the protocol refuses: the key is scoped to assay,commit_root
// 3. the proposer key tries a plain transfer   → the protocol refuses: function-call keys cannot transfer
// 4. the assayer key calls `set_policy`        → the protocol refuses: not in the key's method list
// 5. an outside account calls `propose`        → the gate refuses: "seat calls come through the gate's own keys"
// Each attempt is recorded with the exact error, as a leaf of equal standing with the rounds.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js'
import { RPC } from '../lib/chain.mjs'

const argv = process.argv.slice(2)
const oi = argv.indexOf('--out'); const out = oi >= 0 ? argv[oi + 1] : 'bundles/key-scope'
const gateId = process.env.CAESURA_GATE, pk = process.env.CAESURA_PROPOSER_KEY, ak = process.env.CAESURA_ASSAYER_KEY, network = process.env.CAESURA_NETWORK || 'testnet'
if (!gateId || !pk || !ak) { console.error('set CAESURA_GATE, CAESURA_PROPOSER_KEY, CAESURA_ASSAYER_KEY'); process.exit(1) }
const provider = new JsonRpcProvider({ url: RPC[network] })
const TGAS = (n) => BigInt(n) * 1_000_000_000_000n
const proposer = new Account(gateId, provider, pk), assayer = new Account(gateId, provider, ak)
const stubReceipt = { model: 'stub', request_hash: '0'.repeat(64), response_hash: '1'.repeat(64), signing_address: '', signature: '', signature_kind: 'stub', signing_algo: 'none' }
const kappa = 'sha256:' + 'a'.repeat(64)

async function attempt(name, fn) {
  try { const r = await fn(); return { name, outcome: 'ALLOWED', detail: JSON.stringify(r).slice(0, 200) } }
  catch (e) { const msg = (e && (e.message || String(e))) || 'error'; return { name, outcome: 'refused', detail: msg.replace(/\s+/g, ' ').slice(0, 260) } }
}

const results = []
results.push(await attempt('proposer key calls assay', () => proposer.signAndSendTransaction({ receiverId: gateId, actions: [actions.functionCall('assay', { id: 0, verdict: { approve: true, reason: 'x', assay_kappa: kappa, receipt: stubReceipt } }, TGAS(30), 0n)] })))
results.push(await attempt('assayer key calls propose', () => assayer.signAndSendTransaction({ receiverId: gateId, actions: [actions.functionCall('propose', { action: { receiver_id: 'compute.caesura.testnet', method_name: null, args_base64: null, deposit: '1', gas_tgas: null }, proposal_kappa: kappa, receipt: stubReceipt }, TGAS(30), 0n)] })))
results.push(await attempt('proposer key transfers 1 yocto', () => proposer.signAndSendTransaction({ receiverId: 'drain.caesura.testnet', actions: [actions.transfer(1n)] })))
results.push(await attempt('assayer key calls set_policy', () => assayer.signAndSendTransaction({ receiverId: gateId, actions: [actions.functionCall('set_policy', { policy: { max_per_action: '1', max_per_day: '1', cooldown_ms: 0, receivers: [], methods: [] } }, TGAS(30), 0n)] })))
const stranger = new Account('soulbis.testnet', provider, process.env.CAESURA_STRANGER_KEY || KeyPair.fromRandom('ed25519').toString())
results.push(await attempt('outside account calls propose', () => stranger.signAndSendTransaction({ receiverId: gateId, actions: [actions.functionCall('propose', { action: { receiver_id: 'compute.caesura.testnet', method_name: null, args_base64: null, deposit: '1', gas_tgas: null }, proposal_kappa: kappa, receipt: stubReceipt }, TGAS(30), 0n)] })))

mkdirSync(out, { recursive: true })
const lines = ['# Key-scope abuse attempts · ' + gateId, '', '| attempt | outcome | what was said |', '|---|---|---|', ...results.map(r => `| ${r.name} | **${r.outcome}** | ${r.detail.replace(/\|/g, '\\|')} |`), '']
writeFileSync(join(out, 'REPORT.md'), lines.join('\n'))
writeFileSync(join(out, 'attempts.json'), JSON.stringify({ gate: gateId, network, at: new Date().toISOString(), results }, null, 2) + '\n')
for (const r of results) console.log(`  ${r.outcome.padEnd(8)} ${r.name} — ${r.detail.slice(0, 120)}`)
const allRefused = results.every(r => r.outcome === 'refused')
console.log(allRefused ? 'KEY SCOPE: HELD (5/5 refused)' : 'KEY SCOPE: BREACH')
process.exit(allRefused ? 0 : 1)
