// nearai.mjs — a seat's inference on NEAR AI Cloud, with the receipt that proves it.
//
// POST {base}/v1/chat/completions with the OpenAI shape, hashing the EXACT request bytes
// sent and the EXACT response bytes received (Accept-Encoding: identity, no re-serialising).
// Then GET /v1/signature/{id} for the enclave's signature over
//   provider_tee: "{model}:{request_hash}:{response_hash}"   gateway: "{request_hash}:{response_hash}"
// and, before the completion, GET /v1/attestation/report with a fresh nonce so the signing
// key is bound to a hardware quote (the deeper TDX/NRAS checks are the official verifier's;
// here we keep the report and check the nonce echo and signer match).
//
// Signing algo: ed25519 (so a verifier needs only node:crypto). The receipt is a plain
// object the bundle stores and tools/verify.mjs re-checks.

import { createHash, randomBytes } from 'node:crypto'

const BASE = process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai'
const KEY = process.env.NEARAI_API_KEY

export function receiptText(r) {
  return r.signature_kind === 'provider_tee' ? `${r.model}:${r.request_hash}:${r.response_hash}` : `${r.request_hash}:${r.response_hash}`
}

export async function attest(model, { algo = 'ed25519' } = {}) {
  if (!KEY) throw new Error('NEARAI_API_KEY is not set')
  const nonce = randomBytes(32).toString('hex')
  const u = new URL(BASE + '/v1/attestation/report')
  u.searchParams.set('model', model); u.searchParams.set('signing_algo', algo); u.searchParams.set('nonce', nonce)
  const res = await fetch(u, { headers: { authorization: 'Bearer ' + KEY, 'x-no-aliasing': 'true' } })
  if (!res.ok) throw new Error(`attestation ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const report = await res.json()
  const g = report.gateway_attestation || {}
  const nonceOk = (g.request_nonce || '').toLowerCase() === nonce
  const models = report.model_attestations || []
  return { nonce, nonceOk, gateway_signing_address: g.signing_address, model_signing_addresses: models.map(m => m.signing_address), report }
}

export async function complete({ model, messages, schema, maxTokens = Number(process.env.CAESURA_MAX_TOKENS) || 2000, temperature = 0.2, algo = 'ed25519' }) {
  if (!KEY) throw new Error('NEARAI_API_KEY is not set')
  const body = { model, messages, max_tokens: maxTokens, temperature, stream: false }
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'seat', schema } }
  const requestBytes = Buffer.from(JSON.stringify(body))
  const request_hash = sha(requestBytes)
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY, 'accept-encoding': 'identity' },
    body: requestBytes,
  })
  const inference_id = res.headers.get('inference-id') || res.headers.get('x-request-id') || ''
  const responseBytes = Buffer.from(await res.arrayBuffer())
  if (!res.ok) throw new Error(`completion ${res.status}: ${responseBytes.toString().slice(0, 300)}`)
  const response_hash = sha(responseBytes)
  const data = JSON.parse(responseBytes.toString())
  const text = data.choices?.[0]?.message?.content ?? ''
  const id = data.id
  const sig = await signature(id, model, algo)
  const receipt = {
    model: sig.model || model, request_hash, response_hash,
    signing_address: sig.signing_address || '', signature: sig.signature || '',
    signature_kind: sig.signature_kind || 'none', signing_algo: sig.signing_algo || algo, completion_id: id,
  }
  const textOk = !sig.text || sig.text === receiptText(receipt)
  return { text, id, receipt, textOk, raw: data, inference_id }
}

async function signature(id, model, algo) {
  const u = new URL(BASE + '/v1/signature/' + encodeURIComponent(id))
  u.searchParams.set('signing_algo', algo); u.searchParams.set('model', model)
  const res = await fetch(u, { headers: { authorization: 'Bearer ' + KEY } })
  if (res.status === 404) return { signature_kind: 'none' }
  if (!res.ok) throw new Error(`signature ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const s = await res.json()
  if (s.error_code) return { signature_kind: 'unavailable', error: s.error_code }
  return { ...s, model: s.model || model }
}

const sha = (b) => createHash('sha256').update(b).digest('hex')

// cost of the pause: USD spent on the listed inference ids (billing endpoint; best effort)
export async function costOf(ids) {
  if (!KEY || !ids.length) return null
  const res = await fetch(BASE + '/v1/billing/costs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ requestIds: ids }) })
  if (!res.ok) throw new Error(`billing ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const j = await res.json()
  const rows = Array.isArray(j) ? j : (j.requests || j.data || j.costs || j.results || [])
  let nano = 0; for (const r of rows) nano += Number(r.costNanoUsd || r.cost_nano_usd || 0)
  return { requests: ids.length, nano_usd: nano, usd: nano / 1e9, raw: j }
}
