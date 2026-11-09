// hybrid.mjs — a seat key that can sign twice: ed25519 (the key the gate already holds as the
// seat's function-call key) and a post-quantum key beside it. Three suites, chosen per seat
// by data; the ladder is the weight of each key:
//
//   ed25519                    the classical seat key alone                       (light; rotates often)
//   mldsa65-ed25519            ML-DSA-65 (FIPS 204, lattice) AND ed25519           (the releasing seat)
//   slhdsa-sha2-128s-ed25519   SLH-DSA-SHA2-128s (FIPS 205, hash-based) AND ed25519 (the owner; signs rarely)
//
// In a composite both halves sign the same message and both must verify; a broken half fails
// the whole. The message follows the shape of the IETF LAMPS composite-signature drafts
// (prefix ‖ domain ‖ len(ctx) ‖ ctx ‖ PH(M)), with Caesura's own domain string per suite, so a
// signature made for one suite or one use can never be replayed as another. PH is an
// interleaved pre-hash: the bytes of SHA-256(M) and SHA3-256(M) interleaved, 64 bytes, so the
// message binding does not rest on one hash function either. The suite is data in the bundle
// and in the key commitment, which is the crypto agility: a seat moves suite by a ceremony
// (tools/keys.mjs ceremony), not by a code change.
//
// Deps: node:crypto for ed25519 + both hashes, @noble/post-quantum for ML-DSA-65 and SLH-DSA,
// bs58 (via near-api-js) for NEAR's key text.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { slh_dsa_sha2_128s } from '@noble/post-quantum/slh-dsa.js'
import bs58 from 'bs58'
import * as D from './dcbor.mjs'

// the post-quantum halves: an algorithm id, its implementation, and its sizes (checked on verify)
export const PQ = {
  'mldsa65': { impl: ml_dsa65, title: 'ML-DSA-65', standard: 'FIPS 204', pub: 1952, sig: 3309, assumption: 'module lattice' },
  'slhdsa-sha2-128s': { impl: slh_dsa_sha2_128s, title: 'SLH-DSA-SHA2-128s', standard: 'FIPS 205', pub: 32, sig: 7856, assumption: 'hash function only' },
}
export const SUITES = {
  'ed25519': { ed25519: true, pq: null, title: 'ed25519 (classical)', weight: 1 },
  'mldsa65-ed25519': { ed25519: true, pq: 'mldsa65', title: 'ML-DSA-65 + ed25519 (composite)', weight: 2 },
  'slhdsa-sha2-128s-ed25519': { ed25519: true, pq: 'slhdsa-sha2-128s', title: 'SLH-DSA-SHA2-128s + ed25519 (composite, hash-based)', weight: 3 },
}
export const PREHASH = 'ilv-sha256-sha3-256'
const PREFIX = Buffer.from('CompositeAlgorithmSignatures2025', 'ascii')
const DOMAIN = (suite) => Buffer.from(`caesura/sig/${suite}/1`, 'utf8')
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')

const sha256 = (b) => createHash('sha256').update(b).digest()
const sha3 = (b) => createHash('sha3-256').update(b).digest()
const b64 = (b) => Buffer.from(b).toString('base64')
const unb64 = (s) => Buffer.from(s, 'base64')

// the interleaved pre-hash: byte i of SHA-256 then byte i of SHA3-256, for i in 0..31
export function prehash(msg) {
  const a = sha256(msg), b = sha3(msg), out = Buffer.alloc(64)
  for (let i = 0; i < 32; i++) { out[2 * i] = a[i]; out[2 * i + 1] = b[i] }
  return out
}

// M' = prefix ‖ domain ‖ len(ctx) ‖ ctx ‖ PH(M); ctx is empty here (the domain carries the use)
export function compositeMessage(suite, msg) {
  if (!SUITES[suite]) throw new Error('unknown suite ' + suite)
  return Buffer.concat([PREFIX, DOMAIN(suite), Buffer.from([0]), prehash(msg)])
}

// ---- keys -------------------------------------------------------------------------------
export function parseNearKey(text) {          // "ed25519:<base58 seed‖pub>" (private) or "ed25519:<base58 pub>" (public)
  const [curve, b58] = String(text).split(':'); if (curve !== 'ed25519') throw new Error('not an ed25519 NEAR key')
  const bytes = Buffer.from(bs58.decode(b58))
  if (bytes.length === 64) return { seed: bytes.subarray(0, 32), pub: bytes.subarray(32) }
  if (bytes.length === 32) return { seed: null, pub: bytes }
  throw new Error('bad key length ' + bytes.length)
}
export const nearPubText = (pub) => 'ed25519:' + bs58.encode(pub)
const edPubOfSeed = (seed) => Buffer.from(createPublicKey(createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' })).subarray(-32)

// keygen: the ed25519 half may be an existing NEAR key (a seat's function-call key, or the owner's
// account key given as a credentials-file reference so the seed is never copied out of it)
export function keygen(suite, nearPrivateKey = null, { cred = null } = {}) {
  if (!SUITES[suite]) throw new Error('unknown suite ' + suite)
  let seed, pub
  if (cred) ({ seed, pub } = parseNearKey(JSON.parse(readFileSync(expand(cred), 'utf8')).private_key))
  else if (nearPrivateKey) ({ seed, pub } = parseNearKey(nearPrivateKey))
  else { seed = randomBytes(32); pub = edPubOfSeed(seed) }
  const key = { suite, ed25519: cred ? { pub: nearPubText(pub), cred } : { pub: nearPubText(pub), seed: seed.toString('base64') } }
  const alg = SUITES[suite].pq
  if (alg) { const k = PQ[alg].impl.keygen(); key.pq = { alg, pub: b64(k.publicKey), sk: b64(k.secretKey) } }
  return key
}
const expand = (p) => p.replace(/^~(?=$|[\\/])/, homedir())
// a key as written by tools/keys.mjs; resolves an ed25519 credentials reference and the old
// `mldsa65` field name
export function normalizeKey(key) {
  const k = { ...key }
  if (!k.pq && k.mldsa65) k.pq = { alg: 'mldsa65', pub: k.mldsa65.pub, sk: k.mldsa65.sk }
  return k
}
export function loadKeys(path) {
  const j = JSON.parse(readFileSync(expand(path), 'utf8'))
  return Object.fromEntries(Object.entries(j).map(([seat, k]) => [seat, normalizeKey(k)]))
}
function seedOf(key) {
  if (key.ed25519.seed) return unb64(key.ed25519.seed)
  if (key.ed25519.cred) return parseNearKey(JSON.parse(readFileSync(expand(key.ed25519.cred), 'utf8')).private_key).seed
  throw new Error('key has no ed25519 seed or credentials reference')
}
export function publicOf(key) {
  const k = normalizeKey(key)
  return { suite: k.suite, ed25519_pub: k.ed25519.pub, pq_alg: k.pq ? k.pq.alg : null, pq_pub: k.pq ? k.pq.pub : null }
}
// the key commitment: the address of the seat-key object (what a gate would store per seat);
// the suite names the pq algorithm, so the commitment binds algorithm, both public keys and the seat
export function keyCommitment(pub) {
  const pk = pub.pq_pub || pub.mldsa65_pub
  const mk = pk ? D.kappaFromBytes(unb64(pk)) : ''
  return D.kappaFromValue(new Map([[0, 'caesura/seat-key/1'], [1, pub.seat || ''], [2, pub.suite], [3, pub.ed25519_pub], [4, mk]]))
}

// ---- sign / verify ------------------------------------------------------------------------
export function signMessage(key, msg) {
  const k = normalizeKey(key)
  const m = compositeMessage(k.suite, msg)
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seedOf(k)]), format: 'der', type: 'pkcs8' })
  const out = { suite: k.suite, prehash: PREHASH, ed25519_sig: edSign(null, m, priv).toString('hex'), pq_alg: null, pq_sig: null }
  const alg = SUITES[k.suite].pq
  if (alg) {
    if (!k.pq || k.pq.alg !== alg) throw new Error(`suite ${k.suite} needs a ${PQ[alg].title} key`)
    out.pq_alg = alg; out.pq_sig = b64(PQ[alg].impl.sign(m, unb64(k.pq.sk)))
  }
  return out
}

// pub = { suite, ed25519_pub, pq_pub } (or the older mldsa65_pub); sig = signMessage output
// (pq_sig base64 or bytes; the older mldsa65_sig name is accepted)
export function verifyMessage(pub, msg, sig) {
  const res = { suite: sig.suite, ok: false, ed25519: false, pq_alg: null, pq: null, note: '' }
  if (!SUITES[sig.suite]) { res.note = 'unknown suite'; return res }
  if (sig.suite !== pub.suite) { res.note = `signature suite ${sig.suite} is not the key's ${pub.suite}`; return res }
  if (sig.prehash && sig.prehash !== PREHASH) { res.note = 'unknown prehash ' + sig.prehash; return res }
  const m = compositeMessage(sig.suite, msg)
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, parseNearKey(pub.ed25519_pub).pub]), format: 'der', type: 'spki' })
    res.ed25519 = edVerify(null, m, key, Buffer.from(sig.ed25519_sig, 'hex'))
  } catch (e) { res.note = 'ed25519: ' + e.message }
  const alg = SUITES[sig.suite].pq
  if (alg) {
    res.pq_alg = alg
    try {
      const raw = sig.pq_sig ?? sig.mldsa65_sig; const pk = pub.pq_pub ?? pub.mldsa65_pub
      if (!raw || !pk) throw new Error('missing pq half')
      const s = typeof raw === 'string' ? unb64(raw) : Buffer.from(raw); const p = unb64(pk)
      if (s.length !== PQ[alg].sig || p.length !== PQ[alg].pub) throw new Error(`bad ${PQ[alg].title} length (sig ${s.length}, pub ${p.length})`)
      res.pq = PQ[alg].impl.verify(s, m, p)
    } catch (e) { res.pq = false; res.note = PQ[alg].title.toLowerCase() + ': ' + e.message }
  }
  res.ok = res.ed25519 && (res.pq !== false)
  return res
}
