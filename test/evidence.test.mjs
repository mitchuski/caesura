import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as D from '../lib/dcbor.mjs'
import { mintRound, verifyBundle } from '../lib/evidence.mjs'
import { verifyReceipt, receiptText } from '../lib/receipt_verify.mjs'
import { generateKeyPairSync, sign } from 'node:crypto'

function sample(approve = true) {
  const canon = D.encode(new Map([[0, 'caesura/proposal-canon/1'], [1, 't1'], [2, 'compute.testnet'], [3, null], [4, null], [5, '100000000000000000000000']]))
  const pk = D.kappaFromBytes(canon)
  const stub = (seat) => ({ model: 'stub-' + seat, request_hash: 'a'.repeat(64), response_hash: 'b'.repeat(64), signing_address: '', signature: '', signature_kind: 'stub', signing_algo: 'none', completion_id: '' })
  return {
    round: 'r-test', minted_at: '2026-10-20T00:00:00Z',
    task: { task_id: 't1', text: 'pay 0.1 NEAR to compute.testnet' },
    policy: { max_per_action: '500000000000000000000000', max_per_day: '2000000000000000000000000', cooldown_ms: 1000, receivers: ['compute.testnet'], methods: [''] },
    proposal: { canon, proposal_kappa: pk, model: 'stub-proposer' },
    receipts: { proposer: stub('proposer'), assayer: stub('assayer') },
    verdict: { approve, reason: approve ? 'fits' : 'no', assay_kappa: 'sha256:' + 'c'.repeat(64), model: 'stub-assayer' },
    chain: { network: 'local', gate: 'gate.local', proposal_id: 0, status: approve ? 'executed' : 'refused', refusal: approve ? '' : 'verdict: no', propose_tx: '', assay_tx: '' },
  }
}

test('mint then verify re-derives the root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caesura-'))
  const { root } = mintRound(dir, sample())
  const r = verifyBundle(dir)
  assert.deepEqual(r.problems, [])
  assert.equal(r.root, root)
})

test('minting is deterministic for the same inputs', () => {
  const a = mintRound(mkdtempSync(join(tmpdir(), 'caesura-')), sample())
  const b = mintRound(mkdtempSync(join(tmpdir(), 'caesura-')), sample())
  assert.equal(a.root, b.root); assert.equal(a.merkle, b.merkle)
})

test('one flipped byte fails more than one check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caesura-'))
  mintRound(dir, sample())
  const blobs = readdirSync(join(dir, 'blobs'))
  const p = join(dir, 'blobs', blobs[0]); const b = Buffer.from(readFileSync(p)); b[b.length - 1] ^= 1; writeFileSync(p, b)
  const r = verifyBundle(dir)
  assert.ok(r.problems.length >= 2, r.problems.join('\n'))
})

test('a refusal by the assayer must be a refusal on the chain record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caesura-'))
  const s = sample(false); s.chain.status = 'executed'; s.chain.refusal = ''
  mintRound(dir, s)
  const r = verifyBundle(dir)
  assert.ok(r.problems.some(p => p.includes('assayer refused')))
})

test('a leaked secret-looking string is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caesura-'))
  const s = sample(); s.verdict.reason = 'used key sk-abcdefghijklmnop'
  mintRound(dir, s)
  assert.ok(verifyBundle(dir).problems.some(p => p.startsWith('leak')))
})

test('ed25519 receipt verifies with node:crypto only', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  const r = { model: 'Qwen/Qwen3.8-27B', request_hash: '1'.repeat(64), response_hash: '2'.repeat(64), signing_address: pub, signature_kind: 'provider_tee', signing_algo: 'ed25519' }
  r.signature = sign(null, Buffer.from(receiptText(r)), privateKey).toString('hex')
  assert.equal(verifyReceipt(r).status, 'verified')
  assert.equal(verifyReceipt({ ...r, response_hash: '3'.repeat(64) }).status, 'bad_signature')
  assert.equal(verifyReceipt({ ...r, signature_kind: 'stub' }).status, 'stub')
  assert.equal(verifyReceipt({ ...r, signing_algo: 'ecdsa' }).status, 'unchecked')
})
