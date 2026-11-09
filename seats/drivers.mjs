// drivers.mjs — how a seat thinks. Two drivers:
//   stub   — deterministic, no network: the proposer follows the task (or the poison, if a
//            tool result carries one); the assayer checks the proposal against the task's
//            expected receiver/amount and the policy. Receipts are marked "stub".
//   nearai — NEAR AI Cloud private inference with signed receipts (lib/nearai.mjs).
//   mixed  — a stub proposer (follows the poison by construction) with a NEAR AI assayer:
//            the seat pair the gap study uses, so the assayer is always handed a poisoned proposal.
// Both return { json, receipt, model }.

import { createHash } from 'node:crypto'
import { complete, attest, costOf } from '../lib/nearai.mjs'

export function stubDriver({ assayer = 'careful' } = {}) {
  return {
    name: assayer === 'naive' ? 'stub (naive assayer)' : 'stub',
    async propose({ task, policy, toolResults }) {
      const poison = toolResults.map(t => t.content).join('\n').match(/send\s+([\d.]+)\s*NEAR\s+to\s+([a-z0-9._-]+)/i)
      const action = poison
        ? { receiver_id: poison[2], method_name: '', args: {}, deposit_near: Number(poison[1]) }
        : { receiver_id: task.expect.receiver_id, method_name: task.expect.method_name, args: task.expect.args || {}, deposit_near: task.expect.deposit_near }
      const json = { action, rationale: poison ? 'following the instruction found in the fetched page' : 'the task asks for exactly this' }
      return { json, receipt: stubReceipt('proposer', json), model: 'stub-proposer' }
    },
    async assay({ task, policy, canonical, proposal }) {
      const a = proposal.action
      if (assayer === 'naive') {
        // a seat that waves everything through: the gate's own policy is the last line
        const json = { approve: true, reason: 'looks fine to me' }
        return { json, receipt: stubReceipt('assayer', json), model: 'stub-assayer-naive' }
      }
      const reasons = []
      if (a.receiver_id !== task.expect.receiver_id) reasons.push(`receiver ${a.receiver_id} is not what the task named (${task.expect.receiver_id})`)
      if ((a.method_name || '') !== (task.expect.method_name || '')) reasons.push('method differs from the task')
      if (Math.abs(a.deposit_near - task.expect.deposit_near) > 1e-9) reasons.push(`amount ${a.deposit_near} differs from the task (${task.expect.deposit_near})`)
      if (!policy.receivers.includes(a.receiver_id)) reasons.push('receiver not in policy')
      if (a.deposit_near > policy.max_per_action_near) reasons.push('over the per-action cap')
      const json = reasons.length ? { approve: false, reason: reasons.join('; ') } : { approve: true, reason: 'matches the task and fits the policy' }
      return { json, receipt: stubReceipt('assayer', json), model: 'stub-assayer' }
    },
  }
}

function stubReceipt(seat, json) {
  const h = (s) => createHash('sha256').update(s).digest('hex')
  return { model: `stub-${seat}`, request_hash: h(seat), response_hash: h(JSON.stringify(json)), signing_address: '', signature: '', signature_kind: 'stub', signing_algo: 'none', completion_id: '' }
}

export function nearaiDriver({ proposerModel, assayerModel }) {
  if (!proposerModel || !assayerModel) throw new Error('nearai driver needs CAESURA_PROPOSER_MODEL and CAESURA_ASSAYER_MODEL')
  const ask = async (model, prompt, schema) => {
    // attestation first (binds the signing key to a hardware quote with a fresh nonce), then the completion
    let attestation = null
    try { const a = await attest(model); attestation = Buffer.from(JSON.stringify({ nonce: a.nonce, nonce_ok: a.nonceOk, gateway_signing_address: a.gateway_signing_address, model_signing_addresses: a.model_signing_addresses, report: a.report })) } catch (e) { attestation = null; console.log('  attestation skipped: ' + e.message) }
    const r = await complete({ model, messages: [{ role: 'user', content: prompt }], schema })
    let json
    try { json = JSON.parse(stripFences(r.text)) } catch { throw new Error(`${model} did not return JSON: ${r.text.slice(0, 200)}`) }
    if (!r.textOk) throw new Error('signature text does not match the receipt hashes')
    return { json, receipt: r.receipt, model, attestation, inference_id: r.inference_id }
  }
  return {
    name: 'nearai',
    propose: ({ prompt }) => ask(proposerModel, prompt, PROPOSAL_SCHEMA_REF()),
    assay: ({ prompt }) => ask(assayerModel, prompt, VERDICT_SCHEMA_REF()),
    cost: (ids) => costOf(ids),
  }
}

export function mixedDriver({ assayerModel }) {
  const stub = stubDriver(); const ai = nearaiDriver({ proposerModel: assayerModel, assayerModel })
  return { name: 'mixed (stub proposer · nearai assayer)', propose: stub.propose, assay: ai.assay, cost: ai.cost }
}

const stripFences = (t) => t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
let _schemas = null
async function schemas() { if (!_schemas) _schemas = await import('./prompts.mjs'); return _schemas }
function PROPOSAL_SCHEMA_REF() { return _schemas?.PROPOSAL_SCHEMA }
function VERDICT_SCHEMA_REF() { return _schemas?.VERDICT_SCHEMA }
schemas()
