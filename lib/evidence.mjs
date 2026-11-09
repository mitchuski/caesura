// evidence.mjs — one content-addressed bundle per round, and its re-derivation.
//
// Every object is canonical dCBOR; its address is "sha256:" + hex over those bytes
// (lib/dcbor.mjs, the same axis the public agentprivacy harness mints on). Blobs are raw
// bytes addressed the same way. Edges are dCBOR records too. The run root is the address
// of the root object, which names the ledger and the merkle root over every leaf.
//
// mint(bundleDir, round) writes objects/, blobs/, edges/, root.json and REPORT.md.
// verify(bundleDir) sees only those files and re-derives all of it (tools/verify.mjs adds
// the receipt-signature and on-chain checks on top).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as D from './dcbor.mjs'
import { verifyMessage, SUITES } from './hybrid.mjs'

export const NS = 'caesura'
const PRIVATE = /[a-z]:[\\/]users[\\/]|\/c\/users\/|(^|\s)\/home\/|(^|\s)\/root\/|desktop-[a-z0-9]{4}|\\\\wsl|(^|[^a-z0-9])sk-[a-z0-9]{8,}/i

export class Bundle {
  constructor(round, asserter = 'unsigned:caesura') {
    this.round = round; this.asserter = asserter
    this.objects = new Map(); this.blobs = new Map(); this.edges = new Map(); this.names = new Map()
  }
  put(type, fields, name) {
    const v = new Map([[0, `${NS}/${type}`], ...Object.entries(fields).map(([k, x], i) => [i + 1, x])])
    const k = D.kappaFromValue(v); this.objects.set(k, v); if (name) this.names.set(name, k); return k
  }
  putBlob(bytes, name) { const k = D.kappaFromBytes(bytes); this.blobs.set(k, bytes); if (name) this.names.set(name, k); return k }
  edge(s, t, rel) { const e = D.edgeRecord(s, t, rel, this.asserter); const k = D.kappaFromValue(e); this.edges.set(k, e); return k }
  leaves() { return [...this.objects.keys(), ...this.blobs.keys(), ...this.edges.keys()].sort() }
  merkle() { return D.merkleRoot(this.leaves().map(x => Buffer.from(x))).toString('hex') }
}

// fields are positional in the dCBOR map (1..n) — SCHEMA below names them, verify reads by position.
export const SCHEMA = {
  'task/1': ['task_id', 'text'],
  'policy/1': ['max_per_action', 'max_per_day', 'cooldown_ms', 'receivers', 'methods'],
  'proposal/1': ['task_kappa', 'canon_blob', 'proposal_kappa', 'model', 'receipt_kappa'],
  'receipt/1': ['seat', 'model', 'request_hash', 'response_hash', 'signing_address', 'signature', 'signature_kind', 'signing_algo', 'completion_id'],
  'verdict/1': ['proposal_kappa', 'approve', 'reason', 'assay_kappa', 'model', 'receipt_kappa'],
  'chain/1': ['network', 'gate', 'proposal_id', 'status', 'refusal', 'propose_tx', 'assay_tx'],
  'study/1': ['name', 'gap', 'crosses'],   // optional: which study the round belongs to and what crossed the gap to the assayer
  'seat-key/1': ['seat', 'suite', 'ed25519_pub', 'pq_pub_kappa'],   // optional: a seat's public key(s); its address is the key commitment (the suite names the pq algorithm)
  'sig/1': ['seat', 'suite', 'key_kappa', 'message_kappa', 'prehash', 'ed25519_sig', 'pq_sig_kappa'],   // optional: a seat's signature over what it produced (or over a ceremony)
  'key-policy/1': ['proposer_suite', 'assayer_suite', 'owner_suite'],   // optional: which suite each seat must carry (the weight of each key); owner_suite since the ceremony
  // the ceremony: the owner vouches for the seat keys with the heaviest key; a transfer names the keys
  // it leaves and is countersigned by them. kind = 'seat-keys' (first) | 'transfer' (a seat moved suite)
  'ceremony/1': ['kind', 'issued_at', 'key_policy_kappa', 'proposer_key_kappa', 'assayer_key_kappa', 'owner_key_kappa', 'previous_ceremony_kappa', 'previous_proposer_key_kappa', 'previous_assayer_key_kappa'],
  'ledger/1': ['name', 'members', 'round'],
  'root/1': ['round', 'ledger', 'merkle', 'leaves', 'minted_at'],
}

// a typed leaf as mintRound would put it: its value, canonical bytes and address (tools/keys.mjs
// uses it to address the key policy, the seat keys and the ceremony before any round exists)
export function leaf(type, fields) {
  const v = new Map([[0, `${NS}/${type}`], ...Object.entries(fields).map(([k, x], i) => [i + 1, x])])
  const bytes = D.encode(v); return { v, bytes, kappa: D.kappaFromBytes(bytes) }
}
export const keyPolicyLeaf = (p) => leaf('key-policy/1', keyPolicyLeafFields(p))
export const seatKeyLeaf = (seat, pub) => leaf('seat-key/1', { s: seat, u: pub.suite, e: pub.ed25519_pub, m: pub.pq_pub ? D.kappaFromBytes(Buffer.from(pub.pq_pub, 'base64')) : '' })

export function mintRound(dir, r) {
  // r = { round, task:{task_id,text}, policy, proposal:{canon(bytes), proposal_kappa, model, action}, receipts:{proposer, assayer}, verdict:{approve,reason,assay_kappa,model}, chain:{network,gate,proposal_id,status,refusal,propose_tx,assay_tx}, signer? }
  const b = new Bundle(r.round, r.asserter)
  const task = b.put('task/1', { task_id: r.task.task_id, text: r.task.text }, 'task')
  const policy = b.put('policy/1', { a: r.policy.max_per_action, b: r.policy.max_per_day, c: r.policy.cooldown_ms, d: r.policy.receivers, e: r.policy.methods }, 'policy')
  const canon = b.putBlob(r.proposal.canon, 'proposal_canon')
  if (canon !== r.proposal.proposal_kappa) throw new Error('proposal_kappa does not equal the canonical blob address')
  const rp = b.put('receipt/1', receiptFields('proposer', r.receipts.proposer), 'receipt_proposer')
  const att = r.attestations || {}
  if (att.proposer) { const k = b.putBlob(att.proposer, 'attestation_proposer'); b.edge(rp, k, 'evidence-provenance') }
  const proposal = b.put('proposal/1', { t: task, c: canon, k: r.proposal.proposal_kappa, m: r.proposal.model, r: rp }, 'proposal')
  b.edge(proposal, canon, 'evidence-provenance'); b.edge(proposal, task, 'derived-from'); b.edge(proposal, rp, 'evidence-provenance')
  const ra = b.put('receipt/1', receiptFields('assayer', r.receipts.assayer), 'receipt_assayer')
  if (att.assayer) { const k = b.putBlob(att.assayer, 'attestation_assayer'); b.edge(ra, k, 'evidence-provenance') }
  const verdict = b.put('verdict/1', { p: r.proposal.proposal_kappa, a: r.verdict.approve, r: r.verdict.reason, k: r.verdict.assay_kappa, m: r.verdict.model, x: ra }, 'verdict')
  b.edge(verdict, proposal, 'derived-from'); b.edge(verdict, ra, 'evidence-provenance'); b.edge(verdict, policy, 'refers-to')
  const chain = b.put('chain/1', { n: r.chain.network, g: r.chain.gate, i: r.chain.proposal_id, s: r.chain.status, f: r.chain.refusal || '', a: r.chain.propose_tx || '', b: r.chain.assay_tx || '' }, 'chain')
  b.edge(chain, proposal, 'refers-to'); b.edge(chain, verdict, 'derived-from')
  const members = [task, policy, proposal, rp, ra, verdict, chain]
  if (r.study) { const st = b.put('study/1', { n: r.study.name, g: Number(r.study.gap), c: r.study.crosses }, 'study'); b.edge(verdict, st, 'refers-to'); members.push(st) }
  // seat signatures (lib/hybrid.mjs): the proposer signs the canonical proposal bytes, the assayer the
  // canonical verdict bytes; each seat's public key is its own leaf and the key policy names the suites
  if (r.signatures) {
    const S = r.signatures
    const keyPolicy = S.policy ? b.put('key-policy/1', keyPolicyLeafFields(S.policy), 'key_policy') : null
    if (keyPolicy) members.push(keyPolicy)
    // a seat's public key as a leaf (+ its pq public key as a blob); the name tags the role
    const putKey = (seat, pub, name) => {
      const pk = pub.pq_pub ?? pub.mldsa65_pub
      const mk = pk ? b.putBlob(Buffer.from(pk, 'base64'), `pq_pub_${name}`) : ''
      const key = b.put('seat-key/1', { s: seat, u: pub.suite, e: pub.ed25519_pub, m: mk }, `seat_key_${name}`)
      if (mk) b.edge(key, mk, 'evidence-provenance')
      return key
    }
    const putSig = (seat, sig, key, msgK, name) => {
      const raw = sig.pq_sig ?? sig.mldsa65_sig
      const sk = raw ? b.putBlob(Buffer.from(raw, 'base64'), `pq_sig_${name}`) : ''
      const s = b.put('sig/1', { s: seat, u: sig.suite, k: key, m: msgK, h: sig.prehash, e: sig.ed25519_sig, q: sk }, `sig_${name}`)
      b.edge(s, key, 'refers-to'); if (sk) b.edge(s, sk, 'evidence-provenance')
      return s
    }
    const seatKeys = {}
    for (const seat of ['proposer', 'assayer']) {
      const x = S[seat]; if (!x) continue
      const key = putKey(seat, x.pub, seat); seatKeys[seat] = key
      const sig = putSig(seat, x.sig, key, seat === 'proposer' ? r.proposal.proposal_kappa : r.verdict.assay_kappa, seat)
      b.edge(seat === 'proposer' ? proposal : verdict, sig, 'certified-by')
      members.push(key, sig)
    }
    // the ceremony (tools/keys.mjs ceremony): the owner's signature over the key set, and, for a
    // transfer, the signatures of the keys being left. Its address must be the one the signers signed.
    if (S.ceremony) {
      const C = S.ceremony
      const c = b.put('ceremony/1', ceremonyLeafFields(C.ceremony), 'ceremony')
      if (c !== C.kappa) throw new Error(`ceremony re-addresses to ${c}, signers signed ${C.kappa}`)
      if (keyPolicy && C.ceremony.key_policy_kappa !== keyPolicy) throw new Error('ceremony names a key policy that is not this round’s')
      for (const seat of ['proposer', 'assayer']) if (seatKeys[seat] && C.ceremony[`${seat}_key_kappa`] !== seatKeys[seat]) throw new Error(`ceremony names a ${seat} key that is not the one signing this round`)
      if (keyPolicy) b.edge(c, keyPolicy, 'refers-to')
      for (const seat of ['proposer', 'assayer']) if (seatKeys[seat]) b.edge(c, seatKeys[seat], 'refers-to')
      members.push(c)
      for (const sg of C.signers) {
        const name = sg.role === 'owner' ? 'owner' : `${sg.seat}_previous`
        const key = putKey(sg.seat, sg.pub, name)
        const sig = putSig(sg.seat, sg.sig, key, c, name)
        b.edge(c, sig, 'certified-by'); if (sg.role === 'owner') b.edge(c, key, 'refers-to')
        members.push(key, sig)
      }
    }
  }
  const ledger = b.put('ledger/1', { name: `round ${r.round}`, members, round: r.round }, 'ledger')
  for (const m of members) b.edge(ledger, m, 'composed-of')
  const leaves = b.leaves()
  const merkle = D.merkleRoot(leaves.map(x => Buffer.from(x))).toString('hex')
  const root = b.put('root/1', { round: r.round, ledger, merkle, leaves: leaves.length, minted_at: r.minted_at || new Date().toISOString() }, 'root')
  b.edge(root, ledger, 'composed-of')
  write(dir, b, root, merkle)
  return { root, merkle, leaves: leaves.length + 2 }
}

const keyPolicyLeafFields = (p) => p.owner ? { p: p.proposer, a: p.assayer, o: p.owner } : { p: p.proposer, a: p.assayer }
export const ceremonyLeafFields = (c) => ({ k: c.kind, t: c.issued_at, p: c.key_policy_kappa, a: c.proposer_key_kappa, b: c.assayer_key_kappa, o: c.owner_key_kappa, v: c.previous_ceremony_kappa || '', x: c.previous_proposer_key_kappa || '', y: c.previous_assayer_key_kappa || '' })
export const ceremonyLeaf = (c) => leaf('ceremony/1', ceremonyLeafFields(c))

function receiptFields(seat, x) {
  return { seat, model: x.model, rq: x.request_hash, rs: x.response_hash, sa: x.signing_address, sg: x.signature, sk: x.signature_kind, al: x.signing_algo, id: x.completion_id || '' }
}

function write(dir, b, root, merkle) {
  if (existsSync(dir)) rmSync(dir, { recursive: true })
  for (const d of ['objects', 'blobs', 'edges']) mkdirSync(join(dir, d), { recursive: true })
  for (const [k, v] of b.objects) writeFileSync(join(dir, 'objects', hex(k) + '.cbor'), D.encode(v))
  for (const [k, v] of b.blobs) writeFileSync(join(dir, 'blobs', hex(k) + '.bin'), v)
  for (const [k, v] of b.edges) writeFileSync(join(dir, 'edges', hex(k) + '.cbor'), D.encode(v))
  const names = Object.fromEntries([...b.names].map(([n, k]) => [n, k]))
  writeFileSync(join(dir, 'root.json'), JSON.stringify({ round: b.round, root, merkle, names, status: D.STATUS, asserter: b.asserter }, null, 2) + '\n')
  const report = [`# Caesura round ${b.round}`, '', `Evidence root: ${root}`, `Merkle root: ${merkle}`, `Objects ${b.objects.size} · blobs ${b.blobs.size} · edges ${b.edges.size}`, '', 'Re-derive: `node tools/verify.mjs ' + dir.replace(/\\/g, '/') + '`', '']
  writeFileSync(join(dir, 'REPORT.md'), report.join('\n'))
}

const hex = (k) => D.splitKappa(k)[1]

// ------------------------------------------------------------------ verify
export function verifyBundle(dir) {
  const problems = []
  const objects = new Map(), blobs = new Map(), edges = new Map()
  for (const f of ls(join(dir, 'objects'))) { const bytes = readFileSync(join(dir, 'objects', f)); const k = D.kappaFromBytes(bytes); if (hex(k) + '.cbor' !== f) problems.push(`object ${f} does not hash to its name`); objects.set(k, { bytes, v: D.decode(bytes) }) }
  for (const f of ls(join(dir, 'blobs'))) { const bytes = readFileSync(join(dir, 'blobs', f)); const k = D.kappaFromBytes(bytes); if (hex(k) + '.bin' !== f) problems.push(`blob ${f} does not hash to its name`); blobs.set(k, bytes) }
  for (const f of ls(join(dir, 'edges'))) { const bytes = readFileSync(join(dir, 'edges', f)); const k = D.kappaFromBytes(bytes); if (hex(k) + '.cbor' !== f) problems.push(`edge ${f} does not hash to its name`); edges.set(k, D.decode(bytes)) }
  for (const [k, o] of objects) { const re = D.encode(o.v); if (!re.equals(o.bytes)) problems.push(`object ${k} is not canonical`) }
  const rootJson = JSON.parse(readFileSync(join(dir, 'root.json'), 'utf8'))
  const root = objects.get(rootJson.root)
  if (!root) problems.push('root.json names a root object that is not in the bundle')
  const typeOf = (v) => v instanceof Map ? v.get(0) : null
  const field = (v, i) => v.get(i)
  if (root) {
    if (typeOf(root.v) !== `${NS}/root/1`) problems.push('root object has the wrong type')
    const ledgerK = field(root.v, 2); const merkle = field(root.v, 3); const nLeaves = field(root.v, 4)
    const leaves = [...objects.keys(), ...blobs.keys(), ...edges.keys()].filter(k => k !== rootJson.root && !isRootEdge(edges, k, rootJson.root)).sort()
    const re = D.merkleRoot(leaves.map(x => Buffer.from(x))).toString('hex')
    if (re !== merkle) problems.push(`merkle root mismatch: bundle ${re} vs root ${merkle}`)
    if (Number(nLeaves) !== leaves.length) problems.push(`leaf count ${leaves.length} vs root ${nLeaves}`)
    const ledger = objects.get(ledgerK)
    if (!ledger) problems.push('ledger missing')
    else {
      const members = field(ledger.v, 2)
      for (const m of members) {
        if (!objects.has(m)) problems.push(`ledger member ${m} missing`)
        if (![...edges.values()].some(e => e.get(0) === ledgerK && e.get(1) === m)) problems.push(`no composed-of edge ledger→${m}`)
      }
      const byType = (t) => members.map(m => objects.get(m)).filter(o => o && typeOf(o.v) === `${NS}/${t}`)
      const [proposal] = byType('proposal/1'); const [verdict] = byType('verdict/1'); const [chain] = byType('chain/1')
      if (!proposal) problems.push('no proposal object')
      else {
        const canonK = field(proposal.v, 2); const pk = field(proposal.v, 3)
        if (!blobs.has(canonK)) problems.push('proposal canonical blob missing')
        if (canonK !== pk) problems.push('proposal_kappa is not the canonical blob address')
        else if (blobs.has(canonK) && D.kappaFromBytes(blobs.get(canonK)) !== pk) problems.push('proposal_kappa does not re-derive from the blob')
      }
      if (verdict && proposal && field(verdict.v, 1) !== field(proposal.v, 3)) problems.push('verdict does not name the proposal_kappa')
      if (verdict && chain) {
        const approve = field(verdict.v, 2); const status = field(chain.v, 4)
        // 'proposed' is a read that raced finality (the runner re-reads now); --rpc resolves it against the chain
        if (!approve && status !== 'refused' && status !== 'proposed') problems.push(`assayer refused but chain status is ${status}`)
      }
    }
  }
  // receipts that carry an attestation blob: the signing address must be one the hardware report binds
  for (const [k, o] of objects) {
    if (o.v.get(0) !== `${NS}/receipt/1`) continue
    const attEdge = [...edges.values()].find(e => e.get(0) === k && e.get(2) === D.EDGE_RELATION['evidence-provenance'] && blobs.has(e.get(1)))
    if (!attEdge) continue
    try {
      const rep = JSON.parse(Buffer.from(blobs.get(attEdge.get(1))).toString('utf8'))
      const signers = [rep.gateway_signing_address, ...(rep.model_signing_addresses || [])].filter(Boolean).map(x => String(x).toLowerCase().replace(/^0x/, ''))
      const sa = String(o.v.get(5) || '').toLowerCase().replace(/^0x/, '')
      if (rep.nonce_ok === false) problems.push(`attestation for ${k}: nonce not echoed`)
      if (sa && !signers.includes(sa)) problems.push(`receipt ${k}: signing address ${sa.slice(0, 12)}… is not bound by its attestation report`)
    } catch (e) { problems.push(`attestation blob for ${k} unreadable: ${e.message}`) }
  }
  // seat signatures: each sig/1 re-verifies over the bytes it names, with the key leaf it names
  const signatures = []
  const typed = (t) => [...objects.entries()].filter(([, o]) => o.v instanceof Map && o.v.get(0) === `${NS}/${t}`)
  const [proposalO] = typed('proposal/1').map(([, o]) => o.v); const [verdictO] = typed('verdict/1').map(([, o]) => o.v)
  const ceremonies = typed('ceremony/1')
  for (const [k, o] of typed('sig/1')) {
    const [seat, suite, keyK, msgK, ph, edHex, sigK] = [1, 2, 3, 4, 5, 6, 7].map(i => o.v.get(i))
    const overCeremony = ceremonies.some(([ck]) => ck === msgK)
    const entry = { seat, suite, key_kappa: keyK, message_kappa: msgK, over: overCeremony ? 'ceremony' : seat === 'proposer' ? 'proposal' : 'verdict', ok: false, note: '' }
    signatures.push(entry)
    const keyO = objects.get(keyK)
    if (!keyO || keyO.v.get(0) !== `${NS}/seat-key/1`) { problems.push(`sig ${k}: key leaf missing`); entry.note = 'key leaf missing'; continue }
    if (keyO.v.get(1) !== seat) problems.push(`sig ${k}: key leaf is for ${keyO.v.get(1)}, signature says ${seat}`)
    const mk = keyO.v.get(4)
    if (mk && !blobs.has(mk)) { problems.push(`sig ${k}: pq public key blob missing`); entry.note = 'pq key blob missing'; continue }
    const pub = { suite: keyO.v.get(2), ed25519_pub: keyO.v.get(3), pq_pub: mk ? Buffer.from(blobs.get(mk)).toString('base64') : null }
    let msg = null
    if (overCeremony) msg = objects.get(msgK).bytes
    else if (seat === 'proposer') { if (proposalO && proposalO.get(3) !== msgK) problems.push(`sig ${k}: proposer signed ${msgK}, proposal is ${proposalO.get(3)}`); msg = blobs.get(msgK) || null }
    else if (seat === 'assayer' && verdictO) {
      const canon = D.encode(new Map([[0, 'caesura/verdict-canon/1'], [1, verdictO.get(1)], [2, verdictO.get(2)], [3, verdictO.get(3)]]))
      const ck = D.kappaFromBytes(canon)
      if (ck !== verdictO.get(4)) problems.push(`verdict assay_kappa does not re-derive from its fields`)
      if (ck !== msgK) problems.push(`sig ${k}: assayer signed ${msgK}, verdict canon is ${ck}`)
      msg = canon
    }
    if (!msg) { problems.push(`sig ${k}: nothing to verify against`); entry.note = 'no message'; continue }
    if (sigK && !blobs.has(sigK)) { problems.push(`sig ${k}: pq signature blob missing`); entry.note = 'pq sig blob missing'; continue }
    const res = verifyMessage(pub, msg, { suite, prehash: ph, ed25519_sig: edHex, pq_sig: sigK ? Buffer.from(blobs.get(sigK)) : null })
    Object.assign(entry, { ok: res.ok, ed25519: res.ed25519, pq_alg: res.pq_alg, pq: res.pq, note: res.note, ed25519_pub: pub.ed25519_pub })
    if (!res.ok) problems.push(`sig ${k} (${seat}, ${suite}): ${res.note || 'does not verify'}`)
  }
  // the key policy: the round's own signatures (not the ceremony's) must carry the suites it names;
  // an owner suite means a ceremony signed by the owner with that suite must be in the bundle
  const [keyPolicyEntry] = typed('key-policy/1')
  if (keyPolicyEntry) {
    const o = keyPolicyEntry[1]
    for (const [seat, i] of [['proposer', 1], ['assayer', 2]]) {
      const want = o.v.get(i); const have = signatures.find(x => x.seat === seat && x.over !== 'ceremony')
      if (!have) problems.push(`key policy wants ${seat} to sign with ${want}; no ${seat} signature in the bundle`)
      else if (have.suite !== want) problems.push(`key policy wants ${seat} ${want}; bundle has ${have.suite}`)
    }
    const ownerSuite = o.v.get(3)
    if (ownerSuite) {
      const have = signatures.find(x => x.seat === 'owner' && x.over === 'ceremony')
      if (!have) problems.push(`key policy wants the owner to sign the ceremony with ${ownerSuite}; no owner signature in the bundle`)
      else if (have.suite !== ownerSuite) problems.push(`key policy wants owner ${ownerSuite}; ceremony is signed with ${have.suite}`)
      if (!ceremonies.length) problems.push('key policy names an owner suite but the bundle carries no ceremony')
    }
  }
  // the ceremony: it names this round's key policy and seat keys, the owner key that signed it, and,
  // for a transfer, the keys it left, each of which must have countersigned it (the handover)
  const ceremonyEntries = []
  for (const [ck, co] of ceremonies) {
    const c = fieldsOf(co.v); const e = { kappa: ck, kind: c.kind, issued_at: c.issued_at, previous: c.previous_ceremony_kappa || '', handover: [] }
    ceremonyEntries.push(e)
    if (keyPolicyEntry && c.key_policy_kappa !== keyPolicyEntry[0]) problems.push(`ceremony ${ck}: names key policy ${c.key_policy_kappa}, round has ${keyPolicyEntry[0]}`)
    for (const seat of ['proposer', 'assayer']) {
      const have = signatures.find(x => x.seat === seat && x.over !== 'ceremony')
      if (have && have.key_kappa !== c[`${seat}_key_kappa`]) problems.push(`ceremony ${ck}: names ${seat} key ${c[`${seat}_key_kappa`]}, the round is signed with ${have.key_kappa}`)
    }
    const owner = signatures.find(x => x.seat === 'owner' && x.message_kappa === ck)
    if (!owner) problems.push(`ceremony ${ck}: no owner signature over it`)
    else if (owner.key_kappa !== c.owner_key_kappa) problems.push(`ceremony ${ck}: signed by owner key ${owner.key_kappa}, names ${c.owner_key_kappa}`)
    if (c.kind === 'transfer') {
      for (const seat of ['proposer', 'assayer']) {
        const prev = c[`previous_${seat}_key_kappa`]; if (!prev || prev === c[`${seat}_key_kappa`]) continue
        const hs = signatures.find(x => x.seat === seat && x.message_kappa === ck && x.key_kappa === prev)
        if (!hs) problems.push(`ceremony ${ck}: the ${seat} moved from key ${prev} but that key did not countersign the transfer`)
        else e.handover.push({ seat, from: prev, to: c[`${seat}_key_kappa`], suite: hs.suite, ok: hs.ok })
      }
      if (!c.previous_ceremony_kappa) problems.push(`ceremony ${ck}: a transfer must name the ceremony it leaves`)
    }
  }
  // leak scan over every text in the bundle
  for (const [k, o] of objects) for (const x of o.v.values()) if (typeof x === 'string' && PRIVATE.test(x)) problems.push(`leak in ${k}: ${x.slice(0, 40)}`)
  return { ok: problems.length === 0, problems, root: rootJson.root, merkle: rootJson.merkle, objects: objects.size, blobs: blobs.size, edges: edges.size, signatures, ceremonies: ceremonyEntries, read: { objects, blobs, edges, rootJson } }
}

function isRootEdge(edges, k, rootK) { const e = edges.get(k); return !!e && e.get(0) === rootK }
const ls = (d) => existsSync(d) ? readdirSync(d).filter(f => !f.startsWith('.')).sort() : []

// read a typed object's fields by SCHEMA name
export function fieldsOf(v) {
  const t = v.get(0).replace(`${NS}/`, ''); const names = SCHEMA[t] || []
  return Object.fromEntries(names.map((n, i) => [n, v.get(i + 1)]))
}
