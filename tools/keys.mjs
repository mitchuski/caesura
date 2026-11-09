#!/usr/bin/env node
// keys.mjs — the seats' hybrid keys, the owner's key, and the ceremony that binds them.
//
//   node --env-file=.env.caesura tools/keys.mjs gen [--policy tasks/keys.json] [--out keys/seats.json] [--pub keys/public.json]
//   node tools/keys.mjs owner [--suite slhdsa-sha2-128s-ed25519] [--cred ~/.near-credentials/testnet/caesura.testnet.json] [--out keys/owner.json]
//   node tools/keys.mjs ceremony --keys keys/seats.json --owner keys/owner.json [--policy tasks/keys.json] [--out keys/ceremony.json]
//                                [--previous keys/ceremony-prev.json --previous-keys keys/seats-prev.json]
//
// gen: the ed25519 half of each seat key IS the seat's NEAR function-call key (CAESURA_PROPOSER_KEY /
// CAESURA_ASSAYER_KEY), so the key the gate already holds is the classical half of the composite; the
// post-quantum half is generated here. keys/seats.json (private, gitignored) holds both halves;
// keys/public.json holds the public halves and each seat's key commitment (what a gate would store).
//
// owner: the owner's key. Its ed25519 half is the owner account's own key, referenced by its
// credentials file (never copied); its pq half is hash-based by default (SLH-DSA-SHA2-128s), the
// heaviest rung: slow to sign, small to hold, resting on nothing but the hash function. It signs rarely.
//
// ceremony: the owner vouches for the key set (key policy + the three key commitments) with that key.
// With --previous it is a transfer: the ceremony names the ceremony and the keys it leaves, and every
// seat key being left countersigns it, so a seat moves suite under two signatures, the key it leaves
// and the owner's, and the verifier can walk the chain of ceremonies. Rounds run with --sign carry
// the ceremony under their root.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { keygen, publicOf, keyCommitment, signMessage, loadKeys, SUITES, PQ } from '../lib/hybrid.mjs'
import { keyPolicyLeaf, seatKeyLeaf, ceremonyLeaf } from '../lib/evidence.mjs'

const argv = process.argv.slice(2); const cmd = argv[0]
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const usage = () => { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(1) }
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n') }
const describe = (seat, p) => `${seat}: ${SUITES[p.suite].title} · ed25519 ${p.ed25519_pub}${p.pq_pub ? ' · ' + PQ[p.pq_alg].title + ' pub ' + Buffer.from(p.pq_pub, 'base64').length + ' B' : ''} · commitment ${p.key_kappa}`

if (cmd === 'gen') {
  const policy = JSON.parse(readFileSync(opt('policy', 'tasks/keys.json'), 'utf8'))
  const out = opt('out', 'keys/seats.json'); const pubOut = opt('pub', out.replace(/seats/, 'public'))
  const seats = {}; const pub = { policy: { proposer: policy.proposer, assayer: policy.assayer, ...(policy.owner ? { owner: policy.owner } : {}) }, seats: {} }
  for (const seat of ['proposer', 'assayer']) {
    const suite = policy[seat]; if (!SUITES[suite]) { console.error(`unknown suite ${suite} for ${seat}`); process.exit(1) }
    const near = process.env[seat === 'proposer' ? 'CAESURA_PROPOSER_KEY' : 'CAESURA_ASSAYER_KEY'] || null
    const k = keygen(suite, near); seats[seat] = k
    const p = { seat, ...publicOf(k) }; p.key_kappa = keyCommitment(p); pub.seats[seat] = p
    console.log(describe(seat, p) + (near ? ' (ed25519 = the gate’s seat key)' : ' (ed25519 fresh)'))
  }
  writeJson(out, seats); writeJson(pubOut, pub)
  console.log(`private halves → ${out} (gitignored) · public halves + commitments → ${pubOut}`)
} else if (cmd === 'owner') {
  const suite = opt('suite', 'slhdsa-sha2-128s-ed25519'); if (!SUITES[suite]) { console.error('unknown suite ' + suite); process.exit(1) }
  const network = process.env.CAESURA_NETWORK || 'testnet'; const ownerId = process.env.CAESURA_OWNER || (process.env.CAESURA_GATE || 'gate.caesura.testnet').split('.').slice(1).join('.')
  const cred = opt('cred', `~/.near-credentials/${network}/${ownerId}.json`)
  const out = opt('out', 'keys/owner.json')
  const t0 = Date.now(); const k = keygen(suite, null, { cred }); const ms = Date.now() - t0
  const p = { seat: 'owner', ...publicOf(k) }; p.key_kappa = keyCommitment(p)
  console.log(describe('owner', p) + ` (ed25519 = the owner account’s key, by reference to its credentials file; keygen ${ms} ms)`)
  writeJson(out, { owner: k }); writeJson(out.replace(/owner/, 'owner-public'), { owner: p })
  console.log(`private pq half + credentials reference → ${out} (gitignored) · public → ${out.replace(/owner/, 'owner-public')}`)
} else if (cmd === 'ceremony') {
  const keys = loadKeys(opt('keys', 'keys/seats.json')); const owner = loadKeys(opt('owner', 'keys/owner.json')).owner
  const policyFile = opt('policy', null); const filePolicy = policyFile && existsSync(policyFile) ? JSON.parse(readFileSync(policyFile, 'utf8')) : {}
  const policy = { proposer: keys.proposer.suite, assayer: keys.assayer.suite, owner: owner.suite }
  for (const seat of ['proposer', 'assayer', 'owner']) if (filePolicy[seat] && filePolicy[seat] !== policy[seat]) { console.error(`${policyFile} wants ${seat} ${filePolicy[seat]}, the key is ${policy[seat]}`); process.exit(1) }
  const pubs = { proposer: { seat: 'proposer', ...publicOf(keys.proposer) }, assayer: { seat: 'assayer', ...publicOf(keys.assayer) }, owner: { seat: 'owner', ...publicOf(owner) } }
  const kk = (seat) => seatKeyLeaf(seat, pubs[seat]).kappa
  const c = { kind: 'seat-keys', issued_at: new Date().toISOString(), key_policy_kappa: keyPolicyLeaf(policy).kappa, proposer_key_kappa: kk('proposer'), assayer_key_kappa: kk('assayer'), owner_key_kappa: kk('owner'), previous_ceremony_kappa: '', previous_proposer_key_kappa: '', previous_assayer_key_kappa: '' }
  const signers = []
  const prevPath = opt('previous', null)
  let prevKeys = null
  if (prevPath) {
    const prev = JSON.parse(readFileSync(prevPath, 'utf8')); prevKeys = loadKeys(opt('previous-keys', prevPath.replace(/ceremony/, 'seats')))
    c.kind = 'transfer'; c.previous_ceremony_kappa = prev.kappa; c.previous_proposer_key_kappa = prev.ceremony.proposer_key_kappa; c.previous_assayer_key_kappa = prev.ceremony.assayer_key_kappa
    for (const seat of ['proposer', 'assayer']) {
      const pp = { seat, ...publicOf(prevKeys[seat]) }; const pk = seatKeyLeaf(seat, pp).kappa
      if (pk !== prev.ceremony[`${seat}_key_kappa`]) { console.error(`${seat} key in ${opt('previous-keys', '')} is not the one the previous ceremony names`); process.exit(1) }
    }
  }
  const L = ceremonyLeaf(c)
  const t0 = Date.now(); signers.push({ seat: 'owner', role: 'owner', pub: pubs.owner, sig: signMessage(owner, L.bytes) }); const ownerMs = Date.now() - t0
  const moved = []
  if (prevKeys) for (const seat of ['proposer', 'assayer']) {
    if (c[`previous_${seat}_key_kappa`] === c[`${seat}_key_kappa`]) continue
    moved.push(seat); signers.push({ seat, role: 'previous', pub: { seat, ...publicOf(prevKeys[seat]) }, sig: signMessage(prevKeys[seat], L.bytes) })
  }
  const out = opt('out', 'keys/ceremony.json')
  writeJson(out, { ceremony: c, kappa: L.kappa, policy, signers })
  console.log(`ceremony ${c.kind} ${L.kappa}`)
  console.log(`  key policy ${policy.proposer} / ${policy.assayer} / owner ${policy.owner} → ${c.key_policy_kappa}`)
  for (const seat of ['proposer', 'assayer', 'owner']) console.log(`  ${seat} ${pubs[seat].suite} → ${c[`${seat}_key_kappa`]}`)
  console.log(`  owner signed with ${SUITES[owner.suite].title} in ${ownerMs} ms (${PQ[SUITES[owner.suite].pq].title} sig ${Buffer.from(signers[0].sig.pq_sig, 'base64').length} B)`)
  if (prevKeys) console.log(`  transfer from ceremony ${c.previous_ceremony_kappa}: ${moved.length ? moved.map(s => prevKeys[s].suite === keys[s].suite ? `${s} rotated within ${keys[s].suite}` : `${s} ${prevKeys[s].suite} → ${keys[s].suite}`).join('; ') + ', each countersigned by the key it leaves' : 'no seat moved'}`)
  console.log(`→ ${out}`)
} else usage()
