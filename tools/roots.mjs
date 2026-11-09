#!/usr/bin/env node
// roots.mjs — the public face of the bundles: one line per sealed round, for the site.
//   node tools/roots.mjs [bundlesDir] [--out ../site/roots.json]
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as D from '../lib/dcbor.mjs'
import { fieldsOf } from '../lib/evidence.mjs'

const argv = process.argv.slice(2)
const dir = resolve(argv.find(a => !a.startsWith('--')) || 'bundles')
const oi = argv.indexOf('--out'); const out = oi >= 0 ? argv[oi + 1] : null
const rows = []
for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
  const rj = join(dir, name, 'root.json'); if (!existsSync(rj)) continue
  const root = JSON.parse(readFileSync(rj, 'utf8'))
  const chain = existsSync(join(dir, name, 'chain.json')) ? JSON.parse(readFileSync(join(dir, name, 'chain.json'), 'utf8')) : {}
  if (!chain.network || chain.network === 'local') continue   // sealed rounds only
  const leaves = readdirSync(join(dir, name, 'objects')).length + readdirSync(join(dir, name, 'blobs')).length + readdirSync(join(dir, name, 'edges')).length
  const cost = existsSync(join(dir, name, 'cost.json')) ? JSON.parse(readFileSync(join(dir, name, 'cost.json'), 'utf8')) : null
  const attested = !!(root.names && root.names.attestation_proposer && root.names.attestation_assayer)
  const obj = (k) => fieldsOf(D.decode(readFileSync(join(dir, name, 'objects', k.split(':')[1] + '.cbor'))))
  const signed = root.names && root.names.sig_assayer ? obj(root.names.sig_assayer).suite : ''
  const owner_signed = root.names && root.names.sig_owner ? obj(root.names.sig_owner).suite : ''
  const ceremony = root.names && root.names.ceremony ? obj(root.names.ceremony).kind : ''
  let status = chain.status || 'unsealed', refusal = chain.refusal || ''
  if (status === 'proposed' && root.names && root.names.verdict) { const v = fieldsOf(D.decode(readFileSync(join(dir, name, 'objects', root.names.verdict.split(':')[1] + '.cbor')))); status = v.approve ? 'executed' : 'refused'; refusal = v.approve ? '' : 'verdict: ' + v.reason }
  rows.push({ _id: chain.proposal_id ?? 1e9, root: root.root, attested, signed, owner_signed, ceremony, cost_usd: cost ? Number(cost.usd.toFixed(6)) : null, round: `${name} · ${status}${refusal ? ' · ' + refusal : ''}`, leaves, read: new Date().toISOString().slice(0, 10), network: chain.network || 'local', tx: chain.root_tx || chain.assay_tx || '' })
}
rows.sort((a, b) => a._id - b._id); for (const r of rows) delete r._id
const text = JSON.stringify(rows, null, 2) + '\n'
if (out) { writeFileSync(resolve(out), text); console.log(`${rows.length} roots → ${out}`) } else process.stdout.write(text)
