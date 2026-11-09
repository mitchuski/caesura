#!/usr/bin/env node
// round.mjs — one round of the caesura: propose · assay · gate · root.
//
//   node seats/round.mjs --task tasks/pay-compute.json --driver stub [--chain off|testnet] --round r1
//
// With --chain off the gate is simulated locally (same policy order as the contract) so the
// evidence path runs with nothing but node. With --chain testnet the seats call the gate
// with their own keys (env: CAESURA_GATE, CAESURA_PROPOSER_KEY, CAESURA_ASSAYER_KEY) and
// the root is committed on-chain.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as D from '../lib/dcbor.mjs'
import { mintRound } from '../lib/evidence.mjs'
import { stubDriver, nearaiDriver, mixedDriver } from './drivers.mjs'
import { proposerPrompt, assayerPrompt, GAP_LEVELS } from './prompts.mjs'
import { signMessage, publicOf, parseNearKey, nearPubText, loadKeys, PQ, SUITES } from '../lib/hybrid.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const taskPath = opt('task'); if (!taskPath) { console.error('usage: node seats/round.mjs --task <file> [--driver stub|nearai] [--chain off|testnet] [--round <id>] [--out bundles]'); process.exit(1) }
const task = JSON.parse(readFileSync(taskPath, 'utf8'))
const driverName = opt('driver', 'stub')
const chainMode = opt('chain', 'off')
const round = opt('round', task.task_id)
const outDir = resolve(opt('out', 'bundles'), round)
const policyPath = opt('policy', 'tasks/policy.json')
const policy = JSON.parse(readFileSync(policyPath, 'utf8'))

const NEAR = 10n ** 24n
const yocto = (near) => (BigInt(Math.round(near * 1e6)) * NEAR / 1_000_000n).toString()
const policyOnChain = { max_per_action: yocto(policy.max_per_action_near), max_per_day: yocto(policy.max_per_day_near), cooldown_ms: policy.cooldown_ms, receivers: policy.receivers, methods: policy.methods }

const gap = Math.max(0, Math.min(4, Number(opt('gap', 1))))   // what crosses the gap to the assayer (seats/prompts.mjs GAP_LEVELS)
const study = opt('study', gap === 1 ? '' : 'gap')             // a named study this round belongs to (a leaf in the bundle)
// --sign [keys/seats.json]: each seat signs what it produced with its hybrid key (lib/hybrid.mjs); the
// suites come from the key file's policy (tasks/keys.json at gen time) and become leaves in the bundle
const signIdx = argv.indexOf('--sign')
const keysPath = signIdx >= 0 ? (argv[signIdx + 1] && !argv[signIdx + 1].startsWith('--') ? argv[signIdx + 1] : 'keys/seats.json') : null
const seatKeys = keysPath ? loadKeys(keysPath) : null
// --ceremony [keys/ceremony.json]: the owner's ceremony over this key set (tools/keys.mjs ceremony) rides
// under the root; by default the ceremony.json beside the keys file, when there is one
const ceremonyPath = opt('ceremony', keysPath ? keysPath.replace(/seats/, 'ceremony') : null)
const ceremony = seatKeys && ceremonyPath && existsSync(ceremonyPath) ? JSON.parse(readFileSync(ceremonyPath, 'utf8')) : null
const driver = driverName === 'nearai'
  ? nearaiDriver({ proposerModel: process.env.CAESURA_PROPOSER_MODEL, assayerModel: process.env.CAESURA_ASSAYER_MODEL })
  : driverName === 'mixed' ? mixedDriver({ assayerModel: process.env.CAESURA_ASSAYER_MODEL })
  : stubDriver({ assayer: opt('assayer', 'careful') })

const log = (m) => console.log('  ' + m)
console.log(`caesura round ${round} · driver ${driver.name} · chain ${chainMode} · gap ${gap} (${GAP_LEVELS[gap].join('+')})${study ? ' · study ' + study : ''}${seatKeys ? ` · signed (${seatKeys.proposer.suite} / ${seatKeys.assayer.suite}${ceremony ? ` · ${ceremony.ceremony.kind} ceremony, owner ${ceremony.policy.owner}` : ''})` : ''}`)

// ---- seat 1: propose -----------------------------------------------------------
const toolResults = task.tool_results || []
const pPrompt = proposerPrompt({ task, policy, toolResults })
const proposed = await driver.propose({ task, policy, toolResults, prompt: pPrompt })
const action = normaliseAction(proposed.json.action)
const canonValue = new Map([[0, 'caesura/proposal-canon/1'], [1, task.task_id], [2, action.receiver_id], [3, action.method_name], [4, action.args_base64], [5, action.deposit]])
const canon = D.encode(canonValue)
const proposal_kappa = D.kappaFromBytes(canon)
const canonicalText = `receiver_id: ${action.receiver_id}\nmethod_name: ${action.method_name || '(plain transfer)'}\nargs: ${action.args_base64 ? Buffer.from(action.args_base64, 'base64').toString() : '{}'}\ndeposit: ${proposed.json.action.deposit_near} NEAR\nproposal_kappa: ${proposal_kappa}`
log(`proposed → ${action.receiver_id} ${proposed.json.action.deposit_near} NEAR ${action.method_name ? '· ' + action.method_name : ''}`)
log(`proposal_kappa ${proposal_kappa}`)
log(`proposer receipt: ${proposed.receipt.signature_kind}`)

// ---- seat 2: assay (sees the canonical proposal + task text only) --------------
const aPrompt = assayerPrompt({ task: { text: task.text }, policy, canonical: canonicalText, gap, rationale: String(proposed.json.rationale || ''), toolResults, proposerPrompt: pPrompt })
const assayed = await driver.assay({ task, policy, canonical: canonicalText, proposal: { action: proposed.json.action }, prompt: aPrompt })
const verdictCanon = D.encode(new Map([[0, 'caesura/verdict-canon/1'], [1, proposal_kappa], [2, !!assayed.json.approve], [3, String(assayed.json.reason)]]))
const assay_kappa = D.kappaFromBytes(verdictCanon)
log(`assayed → ${assayed.json.approve ? 'approve' : 'refuse'}: ${assayed.json.reason}`)
log(`assayer receipt: ${assayed.receipt.signature_kind}`)

// ---- the gate --------------------------------------------------------------------
const chainReceipt = { model: proposed.receipt.model, request_hash: proposed.receipt.request_hash, response_hash: proposed.receipt.response_hash, signing_address: proposed.receipt.signing_address, signature: proposed.receipt.signature, signature_kind: proposed.receipt.signature_kind, signing_algo: proposed.receipt.signing_algo }
const verdictOnChain = { approve: !!assayed.json.approve, reason: String(assayed.json.reason).slice(0, 400), assay_kappa, receipt: slim(assayed.receipt) }
let chain
if (chainMode === 'off') {
  const refusal = localPolicyRefusal(policyOnChain, action, verdictOnChain)
  chain = { network: 'local', gate: 'gate.local', proposal_id: 0, status: refusal ? 'refused' : 'executed', refusal: refusal || '', propose_tx: '', assay_tx: '' }
  log(`gate (local) → ${chain.status}${refusal ? ' · ' + refusal : ''}`)
} else {
  const { seatAccount, gate } = await import('../lib/chain.mjs')
  const gateId = process.env.CAESURA_GATE; const pk = process.env.CAESURA_PROPOSER_KEY; const ak = process.env.CAESURA_ASSAYER_KEY
  if (!gateId || !pk || !ak) { console.error('set CAESURA_GATE, CAESURA_PROPOSER_KEY, CAESURA_ASSAYER_KEY'); process.exit(1) }
  const proposer = seatAccount(gateId, pk, chainMode); const assayer = seatAccount(gateId, ak, chainMode)
  let id, p
  const resume = opt('assay-only')
  if (resume != null) {
    // a proposal already on-chain (e.g. its first assay failed at the protocol); the local
    // proposal must re-derive to the same address or this round does not belong to it
    id = Number(resume)
    const onChain = await gate.proposal(gateId, id, chainMode)
    if (!onChain || onChain.proposal_kappa !== proposal_kappa) { console.error(`proposal ${id} on-chain has ${onChain && onChain.proposal_kappa}, local re-derivation is ${proposal_kappa}`); process.exit(2) }
    if (String(onChain.status).toLowerCase() !== 'proposed') { console.error(`proposal ${id} is already ${onChain.status}`); process.exit(2) }
    p = { txHash: '' }
    log(`gate propose → id ${id} (already on-chain, re-derived to the same address)`)
  } else {
    p = await gate.propose(proposer, gateId, action, proposal_kappa, chainReceipt)
    if (p.failure) { console.error('propose failed', JSON.stringify(p.failure)); process.exit(2) }
    id = Number(p.value)
    log(`gate propose → id ${id} · tx ${p.txHash}`)
  }
  // --mid-owner policy:<file> | pause : the owner acts between propose and assay (the door)
  const mid = opt('mid-owner')
  if (mid) {
    const { ownerAccount } = await import('../lib/chain.mjs')
    const { readFileSync: rf, existsSync } = await import('node:fs'); const { homedir } = await import('node:os'); const { join: pj } = await import('node:path')
    const ownerId = process.env.CAESURA_OWNER || gateId.split('.').slice(1).join('.')
    const cred = pj(homedir(), '.near-credentials', chainMode, ownerId + '.json')
    if (!existsSync(cred)) { console.error('no owner credentials for --mid-owner at ' + cred); process.exit(1) }
    const owner = ownerAccount(ownerId, JSON.parse(rf(cred, 'utf8')).private_key, chainMode)
    if (mid.startsWith('policy:')) {
      const np = JSON.parse(rf(mid.slice(7), 'utf8'))
      const r = await gate.setPolicy(owner, gateId, { max_per_action: yocto(np.max_per_action_near), max_per_day: yocto(np.max_per_day_near), cooldown_ms: np.cooldown_ms, receivers: np.receivers, methods: np.methods })
      log(`owner set_policy between propose and assay · tx ${r.txHash}`)
    } else if (mid === 'pause') { const r = await gate.setPaused(owner, gateId, true); log(`owner paused between propose and assay · tx ${r.txHash}`) }
  }
  const a = await gate.assay(assayer, gateId, id, verdictOnChain)
  if (a.failure) { console.error('assay failed', JSON.stringify(a.failure)); process.exit(2) }
  // the view can lag the transaction's finality on some RPC nodes: re-read until the gate has decided
  let after = await gate.proposal(gateId, id, chainMode)
  for (let i = 0; i < 8 && String(after.status).toLowerCase() === 'proposed'; i++) { await new Promise(r => setTimeout(r, 1500)); after = await gate.proposal(gateId, id, chainMode) }
  if (String(after.status).toLowerCase() === 'proposed') log('note: the gate still reads "proposed" after the assay tx; the chain leaf records that read')
  chain = { network: chainMode, gate: gateId, proposal_id: id, status: String(after.status).toLowerCase(), refusal: after.refusal || '', propose_tx: p.txHash, assay_tx: a.txHash }
  log(`gate assay → ${chain.status}${chain.refusal ? ' · ' + chain.refusal : ''} · tx ${a.txHash}`)
  chain._assayer = assayer; chain._gateId = gateId
}

// ---- the seats sign what they produced (optional) -------------------------------
let signatures = null
if (seatKeys) {
  for (const seat of ['proposer', 'assayer']) {
    const envPub = process.env[seat === 'proposer' ? 'CAESURA_PROPOSER_PUB' : 'CAESURA_ASSAYER_PUB']
    if (envPub && envPub !== seatKeys[seat].ed25519.pub) log(`note: ${seat} ed25519 half ${seatKeys[seat].ed25519.pub} is not the gate's seat key ${envPub}`)
  }
  const ps = signMessage(seatKeys.proposer, canon); const as = signMessage(seatKeys.assayer, verdictCanon)
  const policy = ceremony ? ceremony.policy : { proposer: seatKeys.proposer.suite, assayer: seatKeys.assayer.suite }
  signatures = { policy, proposer: { pub: publicOf(seatKeys.proposer), sig: ps }, assayer: { pub: publicOf(seatKeys.assayer), sig: as }, ceremony }
  const pqNote = (s) => s.pq_sig ? ` (${PQ[s.pq_alg].title} ${Buffer.from(s.pq_sig, 'base64').length} B)` : ''
  log(`signed · proposer ${ps.suite} over proposal canon${pqNote(ps)} · assayer ${as.suite} over verdict canon${pqNote(as)}`)
  if (ceremony) log(`ceremony ${ceremony.ceremony.kind} ${ceremony.kappa.slice(0, 23)}… · signed by ${ceremony.signers.map(s => `${s.role === 'owner' ? 'owner' : s.seat + ' (previous key)'} ${s.sig.suite}`).join(', ')}`)
}

// ---- the evidence ------------------------------------------------------------------
const { root, merkle, leaves } = mintRound(outDir, {
  round, task: { task_id: task.task_id, text: task.text },
  attestations: { proposer: proposed.attestation || null, assayer: assayed.attestation || null },
  policy: policyOnChain,
  proposal: { canon, proposal_kappa, model: proposed.model },
  receipts: { proposer: proposed.receipt, assayer: assayed.receipt },
  verdict: { approve: !!assayed.json.approve, reason: String(assayed.json.reason), assay_kappa, model: assayed.model },
  chain: { network: chain.network, gate: chain.gate, proposal_id: chain.proposal_id, status: chain.status, refusal: chain.refusal, propose_tx: chain.propose_tx, assay_tx: chain.assay_tx },
  study: study ? { name: study, gap, crosses: GAP_LEVELS[gap] } : null,
  signatures,
})
log(`evidence root ${root} · ${leaves} leaves · merkle ${merkle.slice(0, 16)}…`)

if (chainMode !== 'off') {
  const { gate } = await import('../lib/chain.mjs')
  const c = await gate.commitRoot(chain._assayer, chain._gateId, chain.proposal_id, round, root)
  if (c.failure) { console.error('commit_root failed', JSON.stringify(c.failure)); process.exit(2) }
  log(`gate commit_root → tx ${c.txHash}`)
  writeFileSync(join(outDir, 'chain.json'), JSON.stringify({ ...chainPublic(chain), root_tx: c.txHash }, null, 2) + '\n')
} else {
  writeFileSync(join(outDir, 'chain.json'), JSON.stringify(chainPublic(chain), null, 2) + '\n')
}
// the private side of the round (prompts, tool results) stays beside the bundle, never inside it
mkdirSync(join(outDir, 'private'), { recursive: true })
writeFileSync(join(outDir, 'private', 'seats.json'), JSON.stringify({ proposer_prompt: pPrompt, proposer_json: proposed.json, assayer_prompt: aPrompt, assayer_json: assayed.json, inference_ids: [proposed.inference_id, assayed.inference_id].filter(Boolean) }, null, 2) + '\n')
if (driver.cost) { try { const cost = await driver.cost([proposed.inference_id, assayed.inference_id].filter(Boolean)); if (cost) { writeFileSync(join(outDir, 'cost.json'), JSON.stringify(cost, null, 2) + '\n'); log(`cost of the pause: $${cost.usd.toFixed(5)} (${cost.requests} requests)`) } } catch (e) { log('cost lookup skipped: ' + e.message) } }
console.log(`done · ${outDir.replace(/\\/g, '/')} · verify: node tools/verify.mjs ${outDir.replace(/\\/g, '/')}`)

// ---- helpers --------------------------------------------------------------------------
function normaliseAction(a) {
  let method = String(a.method_name || '').trim()
  if (/^\(?\s*(plain\s+)?transfer\s*\)?$/i.test(method) || /^(none|null|n\/a|-)$/i.test(method)) method = ''
  const args = a.args && Object.keys(a.args).length ? Buffer.from(JSON.stringify(a.args)).toString('base64') : null
  return { receiver_id: String(a.receiver_id), method_name: method ? method : null, args_base64: args, deposit: yocto(Number(a.deposit_near) || 0), gas_tgas: method ? 30 : null }
}
function slim(r) { const { completion_id, ...rest } = r; return rest }
function chainPublic(c) { const { _assayer, _gateId, ...rest } = c; return rest }
function localPolicyRefusal(p, a, v) {
  if (process.env.CAESURA_LOCAL_PAUSED === '1') return 'paused'
  if (!v.approve) return `verdict: ${v.reason}`
  if (!p.receivers.includes(a.receiver_id)) return 'receiver'
  if (!p.methods.includes(a.method_name || '')) return 'method'
  if (BigInt(a.deposit) > BigInt(p.max_per_action)) return 'cap_action'
  if (BigInt(a.deposit) > BigInt(p.max_per_day)) return 'cap_day'
  return null
}
