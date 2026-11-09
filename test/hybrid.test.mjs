import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as D from '../lib/dcbor.mjs'
import { mintRound, verifyBundle, keyPolicyLeaf, seatKeyLeaf, ceremonyLeaf } from '../lib/evidence.mjs'
import { keygen, publicOf, signMessage, verifyMessage, compositeMessage, prehash, keyCommitment, PQ } from '../lib/hybrid.mjs'

const msg = Buffer.from('the canonical bytes of a proposal')

test('composite: both halves verify, tampering breaks both, suites do not cross', () => {
  const k = keygen('mldsa65-ed25519'); const pub = publicOf(k); const s = signMessage(k, msg)
  assert.equal(Buffer.from(s.ed25519_sig, 'hex').length, 64); assert.equal(Buffer.from(s.pq_sig, 'base64').length, 3309); assert.equal(s.pq_alg, 'mldsa65')
  const ok = verifyMessage(pub, msg, s); assert.equal(ok.ok, true); assert.equal(ok.ed25519, true); assert.equal(ok.pq, true)
  const bad = verifyMessage(pub, Buffer.from('the canonical bytes of a proposaL'), s); assert.equal(bad.ok, false); assert.equal(bad.ed25519, false); assert.equal(bad.pq, false)
  const c = keygen('ed25519'); const cs = signMessage(c, msg)
  assert.equal(verifyMessage(publicOf(c), msg, cs).ok, true)
  assert.equal(verifyMessage(pub, msg, cs).ok, false)                                   // classical sig against a composite key
  assert.equal(verifyMessage(pub, msg, { ...s, pq_sig: cs.ed25519_sig }).ok, false)     // a broken pq half fails the composite
  // the older field names still read
  assert.equal(verifyMessage({ suite: pub.suite, ed25519_pub: pub.ed25519_pub, mldsa65_pub: pub.pq_pub }, msg, { suite: s.suite, prehash: s.prehash, ed25519_sig: s.ed25519_sig, mldsa65_sig: s.pq_sig }).ok, true)
})

test('the hash-based rung: SLH-DSA-SHA2-128s + ed25519 signs and verifies; its halves do not cross with ML-DSA', () => {
  const k = keygen('slhdsa-sha2-128s-ed25519'); const pub = publicOf(k)
  assert.equal(Buffer.from(pub.pq_pub, 'base64').length, 32)
  const s = signMessage(k, msg); assert.equal(Buffer.from(s.pq_sig, 'base64').length, PQ['slhdsa-sha2-128s'].sig)
  const ok = verifyMessage(pub, msg, s); assert.equal(ok.ok, true); assert.equal(ok.pq, true); assert.equal(ok.pq_alg, 'slhdsa-sha2-128s')
  assert.equal(verifyMessage(pub, Buffer.from('x'), s).ok, false)
  const m = keygen('mldsa65-ed25519')
  assert.equal(verifyMessage(publicOf(m), msg, s).ok, false)   // an SLH-DSA signature against an ML-DSA key
  assert.equal(verifyMessage(pub, msg, { ...s, suite: 'mldsa65-ed25519' }).ok, false)
})

test('the message is domain-separated and pre-hashed with both hash functions', () => {
  const a = compositeMessage('ed25519', msg), b = compositeMessage('mldsa65-ed25519', msg), c = compositeMessage('slhdsa-sha2-128s-ed25519', msg)
  assert.notEqual(a.toString('hex'), b.toString('hex')); assert.notEqual(b.toString('hex'), c.toString('hex'))
  assert.equal(prehash(msg).length, 64)
  assert.notEqual(prehash(msg).toString('hex'), prehash(Buffer.from('x')).toString('hex'))
})

test('the ed25519 half can be an existing NEAR seat key', () => {
  const k = keygen('mldsa65-ed25519', 'ed25519:' + randomNearSecret())
  assert.match(k.ed25519.pub, /^ed25519:/)
  assert.equal(verifyMessage(publicOf(k), msg, signMessage(k, msg)).ok, true)
})

function randomNearSecret() {
  const { generateKeyPairSync } = globalThis.process.getBuiltinModule('node:crypto')
  const kp = generateKeyPairSync('ed25519')
  const seed = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return b58(Buffer.concat([seed, pub]))
}
function b58(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = BigInt('0x' + bytes.toString('hex')), out = ''
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break }
  return out
}

function sample() {
  const canon = D.encode(new Map([[0, 'caesura/proposal-canon/1'], [1, 't1'], [2, 'compute.testnet'], [3, null], [4, null], [5, '100000000000000000000000']]))
  const pk = D.kappaFromBytes(canon)
  const verdictCanon = D.encode(new Map([[0, 'caesura/verdict-canon/1'], [1, pk], [2, true], [3, 'fits']]))
  const ak = D.kappaFromBytes(verdictCanon)
  const stub = (seat) => ({ model: 'stub-' + seat, request_hash: 'a'.repeat(64), response_hash: 'b'.repeat(64), signing_address: '', signature: '', signature_kind: 'stub', signing_algo: 'none', completion_id: '' })
  const r = {
    round: 'r-signed', minted_at: '2026-10-20T00:00:00Z',
    task: { task_id: 't1', text: 'pay 0.1 NEAR to compute.testnet' },
    policy: { max_per_action: '500000000000000000000000', max_per_day: '2000000000000000000000000', cooldown_ms: 1000, receivers: ['compute.testnet'], methods: [''] },
    proposal: { canon, proposal_kappa: pk, model: 'stub-proposer' },
    receipts: { proposer: stub('proposer'), assayer: stub('assayer') },
    verdict: { approve: true, reason: 'fits', assay_kappa: ak, model: 'stub-assayer' },
    chain: { network: 'local', gate: 'gate.local', proposal_id: 0, status: 'executed', refusal: '', propose_tx: '', assay_tx: '' },
  }
  return { r, canon, verdictCanon }
}
const pubOf = (seat, k) => ({ seat, ...publicOf(k) })
// what tools/keys.mjs ceremony writes
function makeCeremony(keys, owner, previous = null) {
  const policy = { proposer: keys.proposer.suite, assayer: keys.assayer.suite, owner: owner.suite }
  const kk = (seat, k) => seatKeyLeaf(seat, pubOf(seat, k)).kappa
  const c = { kind: previous ? 'transfer' : 'seat-keys', issued_at: '2026-10-21T00:00:00Z', key_policy_kappa: keyPolicyLeaf(policy).kappa, proposer_key_kappa: kk('proposer', keys.proposer), assayer_key_kappa: kk('assayer', keys.assayer), owner_key_kappa: kk('owner', owner), previous_ceremony_kappa: previous ? previous.kappa : '', previous_proposer_key_kappa: previous ? previous.ceremony.proposer_key_kappa : '', previous_assayer_key_kappa: previous ? previous.ceremony.assayer_key_kappa : '' }
  const L = ceremonyLeaf(c)
  const signers = [{ seat: 'owner', role: 'owner', pub: pubOf('owner', owner), sig: signMessage(owner, L.bytes) }]
  if (previous) for (const seat of ['proposer', 'assayer']) if (c[`previous_${seat}_key_kappa`] !== c[`${seat}_key_kappa`]) signers.push({ seat, role: 'previous', pub: pubOf(seat, previous.keys[seat]), sig: signMessage(previous.keys[seat], L.bytes) })
  return { ceremony: c, kappa: L.kappa, policy, signers, keys }
}

test('a signed bundle verifies; a missing pq blob, a wrong suite or a swapped message fails it', () => {
  const P = keygen('ed25519'), A = keygen('mldsa65-ed25519')
  const { r, canon, verdictCanon } = sample()
  r.signatures = { policy: { proposer: 'ed25519', assayer: 'mldsa65-ed25519' }, proposer: { pub: publicOf(P), sig: signMessage(P, canon) }, assayer: { pub: publicOf(A), sig: signMessage(A, verdictCanon) } }
  const dir = mkdtempSync(join(tmpdir(), 'caesura-sig-'))
  mintRound(dir, r)
  const ok = verifyBundle(dir)
  assert.deepEqual(ok.problems, []); assert.equal(ok.signatures.length, 2)
  assert.equal(ok.signatures.find(s => s.seat === 'assayer').pq, true)
  assert.equal(ok.signatures.find(s => s.seat === 'proposer').pq, null)
  // the key commitment in the bundle is the one tools/keys.mjs prints
  const keyLeaf = [...ok.read.objects.values()].map(o => o.v).find(v => v.get(0) === 'caesura/seat-key/1' && v.get(1) === 'assayer')
  assert.equal(D.kappaFromValue(keyLeaf), keyCommitment({ seat: 'assayer', ...publicOf(A) }))
  // drop the ML-DSA-65 signature blob
  const blobs = readdirSync(join(dir, 'blobs')).map(f => [f, readFileSync(join(dir, 'blobs', f)).length]).filter(([, n]) => n === 3309)
  assert.equal(blobs.length, 1); unlinkSync(join(dir, 'blobs', blobs[0][0]))
  const broken = verifyBundle(dir); assert.ok(broken.problems.some(p => /signature blob missing/.test(p)))
  // the key policy wants a composite assayer but the bundle carries a classical one
  const dir2 = mkdtempSync(join(tmpdir(), 'caesura-sig-'))
  const { r: r2, canon: c2, verdictCanon: v2 } = sample(); const A2 = keygen('ed25519')
  r2.signatures = { policy: { proposer: 'ed25519', assayer: 'mldsa65-ed25519' }, proposer: { pub: publicOf(P), sig: signMessage(P, c2) }, assayer: { pub: publicOf(A2), sig: signMessage(A2, v2) } }
  mintRound(dir2, r2)
  assert.ok(verifyBundle(dir2).problems.some(p => /key policy wants assayer mldsa65-ed25519/.test(p)))
  // the assayer signs the proposal canon instead of its own verdict
  const dir3 = mkdtempSync(join(tmpdir(), 'caesura-sig-'))
  const { r: r3, canon: c3 } = sample()
  r3.signatures = { policy: null, proposer: { pub: publicOf(P), sig: signMessage(P, c3) }, assayer: { pub: publicOf(A), sig: signMessage(A, c3) } }
  mintRound(dir3, r3)
  assert.ok(verifyBundle(dir3).problems.some(p => /\(assayer, mldsa65-ed25519\)/.test(p)))
})

test('the ceremony: the owner signs the key set with the hash-based key; a transfer is countersigned by the key it leaves', () => {
  const owner = keygen('slhdsa-sha2-128s-ed25519')
  const near = 'ed25519:' + randomNearSecret()                       // the proposer's ed25519 half stays the gate's seat key across the transfer
  const keysA = { proposer: keygen('ed25519', near), assayer: keygen('mldsa65-ed25519') }
  const A = makeCeremony(keysA, owner)
  const signed = (keys, cer, canon, verdictCanon) => ({ policy: cer.policy, proposer: { pub: publicOf(keys.proposer), sig: signMessage(keys.proposer, canon) }, assayer: { pub: publicOf(keys.assayer), sig: signMessage(keys.assayer, verdictCanon) }, ceremony: cer })
  // round under the first ceremony
  const { r, canon, verdictCanon } = sample(); r.signatures = signed(keysA, A, canon, verdictCanon)
  const dir = mkdtempSync(join(tmpdir(), 'caesura-cer-')); mintRound(dir, r)
  const ok = verifyBundle(dir)
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.ceremonies.length, 1); assert.equal(ok.ceremonies[0].kind, 'seat-keys')
  const ownerSig = ok.signatures.find(s => s.seat === 'owner'); assert.equal(ownerSig.over, 'ceremony'); assert.equal(ownerSig.pq_alg, 'slhdsa-sha2-128s'); assert.equal(ownerSig.ok, true)
  // the transfer: the proposer rises from ed25519 to the composite, same ed25519 half
  const keysB = { proposer: keygen('mldsa65-ed25519', near), assayer: keysA.assayer }
  const B = makeCeremony(keysB, owner, { ...A, keys: keysA })
  assert.equal(B.signers.length, 2); assert.equal(B.signers[1].seat, 'proposer'); assert.equal(B.signers[1].sig.suite, 'ed25519')
  const { r: r2, canon: c2, verdictCanon: v2 } = sample(); r2.signatures = signed(keysB, B, c2, v2)
  const dir2 = mkdtempSync(join(tmpdir(), 'caesura-cer-')); mintRound(dir2, r2)
  const ok2 = verifyBundle(dir2)
  assert.deepEqual(ok2.problems, [])
  assert.equal(ok2.ceremonies[0].kind, 'transfer'); assert.equal(ok2.ceremonies[0].previous, A.kappa)
  assert.deepEqual(ok2.ceremonies[0].handover.map(h => [h.seat, h.suite, h.ok]), [['proposer', 'ed25519', true]])
  // the transfer without the handover signature fails
  const Bq = { ...B, signers: B.signers.slice(0, 1) }
  const { r: r3, canon: c3, verdictCanon: v3 } = sample(); r3.signatures = signed(keysB, Bq, c3, v3)
  const dir3 = mkdtempSync(join(tmpdir(), 'caesura-cer-')); mintRound(dir3, r3)
  assert.ok(verifyBundle(dir3).problems.some(p => /did not countersign the transfer/.test(p)))
  // a round signed with keys the ceremony does not name is refused at mint
  const { r: r4, canon: c4, verdictCanon: v4 } = sample(); r4.signatures = signed(keysA, B, c4, v4)
  assert.throws(() => mintRound(mkdtempSync(join(tmpdir(), 'caesura-cer-')), r4), /ceremony names a proposer key/)
  // the owner signing with a lighter suite than the policy names fails
  const lightOwner = keygen('ed25519'); const C = makeCeremony(keysA, lightOwner); C.policy.owner = 'slhdsa-sha2-128s-ed25519'
  C.ceremony.key_policy_kappa = keyPolicyLeaf(C.policy).kappa; const L = ceremonyLeaf(C.ceremony); C.kappa = L.kappa; C.signers = [{ seat: 'owner', role: 'owner', pub: pubOf('owner', lightOwner), sig: signMessage(lightOwner, L.bytes) }]
  const { r: r5, canon: c5, verdictCanon: v5 } = sample(); r5.signatures = signed(keysA, C, c5, v5)
  const dir5 = mkdtempSync(join(tmpdir(), 'caesura-cer-')); mintRound(dir5, r5)
  assert.ok(verifyBundle(dir5).problems.some(p => /key policy wants owner slhdsa-sha2-128s-ed25519/.test(p)))
})
