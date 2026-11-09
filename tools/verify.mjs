#!/usr/bin/env node
// verify.mjs — see only the bundle; re-derive everything.
//
//   node tools/verify.mjs bundles/<round> [--rpc testnet]
//
// 1. every object, blob and edge re-hashes to its file name and is canonical dCBOR
// 2. the composed-of walk from the root reaches every ledger member
// 3. proposal_kappa re-derives from the canonical proposal blob
// 4. the verdict names that proposal; a refusal by the assayer is a refusal on the chain record
// 5. each receipt: ed25519 signature over "{model}:{rq}:{rs}" with the signing key (verified /
//    stub / unsigned / unchecked are reported as what they are)
// 6. --rpc: the gate's list_roots on NEAR carries this root for this proposal id
// exit 0 only when 1–4 hold, no receipt is bad, and (with --rpc) the root is on-chain.

import { resolve } from 'node:path'
import { verifyBundle, fieldsOf } from '../lib/evidence.mjs'
import { verifyReceipt } from '../lib/receipt_verify.mjs'
import { PQ } from '../lib/hybrid.mjs'

const argv = process.argv.slice(2)
const dir = argv.find(a => !a.startsWith('--'))
if (!dir) { console.error('usage: node tools/verify.mjs <bundleDir> [--rpc testnet]'); process.exit(1) }
const rpcIdx = argv.indexOf('--rpc'); const network = rpcIdx >= 0 ? (argv[rpcIdx + 1] || 'testnet') : null

const r = verifyBundle(resolve(dir))
const lines = []
const mark = (ok) => ok ? 'ok  ' : 'FAIL'
lines.push(`${mark(r.ok)} bundle: ${r.objects} objects · ${r.blobs} blobs · ${r.edges} edges`)
for (const p of r.problems) lines.push(`     - ${p}`)
lines.push(`     evidence root ${r.root}`)
lines.push(`     merkle ${r.merkle}`)

let bad = !r.ok
const receipts = [...r.read.objects.values()].map(o => o.v).filter(v => v.get(0) === 'caesura/receipt/1').map(fieldsOf)
for (const rc of receipts) {
  const res = verifyReceipt({ model: rc.model, request_hash: rc.request_hash, response_hash: rc.response_hash, signing_address: rc.signing_address, signature: rc.signature, signature_kind: rc.signature_kind, signing_algo: rc.signing_algo })
  const good = res.status === 'verified'
  const soft = ['stub', 'unsigned', 'unchecked'].includes(res.status)
  if (!good && !soft) bad = true
  lines.push(`${good ? 'ok  ' : soft ? 'note' : 'FAIL'} receipt ${rc.seat} (${rc.model}): ${res.status}${res.note ? ' · ' + res.note : ''}`)
}

for (const sg of r.signatures || []) {
  const parts = [`ed25519 ${sg.ed25519 ? 'ok' : 'BAD'}`]; if (sg.pq !== null && sg.pq !== undefined) parts.push(`${PQ[sg.pq_alg] ? PQ[sg.pq_alg].title : sg.pq_alg} ${sg.pq ? 'ok' : 'BAD'}`)
  lines.push(`${sg.ok ? 'ok  ' : 'FAIL'} ${sg.over === 'ceremony' ? 'ceremony' : 'seat'} signature ${sg.seat} (${sg.suite}) over the ${sg.over}: ${parts.join(' · ')}${sg.note ? ' · ' + sg.note : ''} · key ${String(sg.key_kappa).slice(0, 23)}…`)
}
const keyPolicy = [...r.read.objects.values()].map(o => o.v).find(v => v.get(0) === 'caesura/key-policy/1')
if (keyPolicy) lines.push(`     key policy: proposer ${keyPolicy.get(1)} · assayer ${keyPolicy.get(2)}${keyPolicy.get(3) ? ' · owner ' + keyPolicy.get(3) : ''}`)
for (const c of r.ceremonies || []) {
  lines.push(`     ceremony ${c.kind} ${c.kappa.slice(0, 23)}… issued ${c.issued_at}${c.previous ? ' · leaves ' + c.previous.slice(0, 23) + '…' : ''}`)
  for (const h of c.handover) lines.push(`${h.ok ? 'ok  ' : 'FAIL'} handover: the ${h.seat} moved from ${h.from.slice(0, 23)}… (${h.suite}) to ${h.to.slice(0, 23)}…, countersigned by the key it leaves`)
}

const chain = [...r.read.objects.values()].map(o => o.v).find(v => v.get(0) === 'caesura/chain/1')
const verdict = [...r.read.objects.values()].map(o => o.v).find(v => v.get(0) === 'caesura/verdict/1')
if (chain) {
  const c = fieldsOf(chain); const v = verdict ? fieldsOf(verdict) : null
  lines.push(`     chain ${c.network} · ${c.gate} · proposal ${c.proposal_id} · ${c.status}${c.refusal ? ' · ' + c.refusal : ''}`)
  if (v) lines.push(`     verdict ${v.approve ? 'approve' : 'refuse'} · ${v.reason}`)
  if (network && c.network !== 'local' && c.status === 'declined') lines.push('ok   on-chain: nothing reached the gate; the proposer declined, so there is no proposal and no root to match')
  else if (network && c.network !== 'local') {
    const { gate, accessKeys } = await import('../lib/chain.mjs')
    try {
      const roots = await gate.roots(c.gate, network, 0, 200)
      if (c.status === 'proposed') {
        const onChain = await gate.proposal(c.gate, Number(c.proposal_id), network); const st = String(onChain.status).toLowerCase()
        const agrees = v ? (v.approve ? st === 'executed' : st === 'refused') : st !== 'proposed'
        if (agrees) lines.push(`note on-chain: the chain leaf read "proposed" before finality; the gate now says ${st}${onChain.refusal ? ' · ' + onChain.refusal : ''}`)
        else { bad = true; lines.push(`FAIL on-chain: chain leaf says proposed, verdict ${v && v.approve ? 'approve' : 'refuse'}, gate now says ${st}`) }
      }
      const hit = roots.find(x => Number(x.proposal_id) === Number(c.proposal_id) && x.root === r.root)
      if (hit) lines.push(`ok   on-chain: ${c.gate} list_roots carries ${r.root.slice(0, 23)}… for proposal ${c.proposal_id} (round ${hit.round})`)
      else { bad = true; lines.push(`FAIL on-chain: root not found in ${c.gate} list_roots (${roots.length} roots read)`) }
      if ((r.signatures || []).length) {
        const st = await gate.state(c.gate, network)
        for (const sg of r.signatures) {
          if (sg.seat === 'owner') {
            const keys = await accessKeys(st.owner, network)
            const hit = keys.find(k => k.public_key === sg.ed25519_pub)
            if (hit && hit.access_key.permission === 'FullAccess') lines.push(`ok   on-chain: the owner's ed25519 half is a full-access key of ${st.owner}, the gate's owner (${sg.ed25519_pub.slice(0, 20)}…)`)
            else { bad = true; lines.push(`FAIL on-chain: the owner's ed25519 half ${sg.ed25519_pub} is not a full-access key of ${st.owner}`) }
            continue
          }
          const held = st[sg.seat === 'proposer' ? 'proposer_key' : 'assayer_key']
          if (sg.ed25519_pub === held) lines.push(`ok   on-chain: the ${sg.seat}'s ed25519 half${sg.over === 'ceremony' ? ' (previous key, countersigning the transfer)' : ''} is the seat key the gate holds (${held.slice(0, 20)}…)`)
          else { bad = true; lines.push(`FAIL on-chain: the ${sg.seat}'s ed25519 half ${sg.ed25519_pub} is not the gate's seat key ${held}`) }
        }
      }
    } catch (e) { bad = true; lines.push(`FAIL on-chain: ${e.message}`) }
  } else if (network) lines.push('note chain record is local; nothing to read on-chain')
}

console.log(lines.join('\n'))
console.log(bad ? 'VERIFY: FAIL' : 'VERIFY: PASS')
process.exit(bad ? 1 : 0)
