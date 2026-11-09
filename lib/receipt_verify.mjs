// receipt_verify.mjs — check an enclave receipt with node:crypto only (ed25519).
//
// provider_tee: text = "{model}:{request_hash}:{response_hash}"; gateway: "{rq}:{rs}".
// ed25519: a detached 64-byte signature over the UTF-8 text, public key = 32 bytes
// (signing_address). ecdsa (EIP-191 recovery over secp256k1) is not done here; a receipt
// with signing_algo ecdsa is reported as "unchecked (use the official verifier)".
// A stub receipt (signature_kind "stub") is reported as such, never as verified.

import { createPublicKey, verify as edVerify } from 'node:crypto'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function receiptText(r) {
  return r.signature_kind === 'provider_tee' ? `${r.model}:${r.request_hash}:${r.response_hash}` : `${r.request_hash}:${r.response_hash}`
}

export function verifyReceipt(r) {
  if (!r) return { status: 'missing' }
  if (r.signature_kind === 'stub') return { status: 'stub', note: 'no enclave; stub driver' }
  if (r.signature_kind === 'none' || !r.signature) return { status: 'unsigned' }
  if ((r.signing_algo || '').toLowerCase() !== 'ed25519') return { status: 'unchecked', note: `${r.signing_algo}: use the official nearai-cloud-verifier` }
  try {
    const pub = Buffer.from(strip0x(r.signing_address), 'hex')
    const sig = Buffer.from(strip0x(r.signature), 'hex')
    if (pub.length !== 32 || sig.length !== 64) return { status: 'malformed', note: `pub ${pub.length}B sig ${sig.length}B` }
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: 'der', type: 'spki' })
    const ok = edVerify(null, Buffer.from(receiptText(r), 'utf8'), key, sig)
    return { status: ok ? 'verified' : 'bad_signature', kind: r.signature_kind }
  } catch (e) {
    return { status: 'error', note: e.message }
  }
}

const strip0x = (s) => String(s || '').replace(/^0x/i, '')
