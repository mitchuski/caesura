#!/usr/bin/env node
// scroll-export.mjs — the sealed bundles in the shape a Mages City scroll reads: per round a
// root.json (root_kappa, minted_on) and a graph.json (objects keyed by address, edges with
// kappa/source/target). Nothing but addresses and dates leave; the scroll is a page of hashes.
//
//   node tools/scroll-export.mjs [bundlesDir] --out <dir>      (sealed testnet rounds only)
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as D from '../lib/dcbor.mjs'
import { fieldsOf } from '../lib/evidence.mjs'

const argv = process.argv.slice(2)
const dir = resolve(argv.find(a => !a.startsWith('--')) || 'bundles')
const oi = argv.indexOf('--out'); if (oi < 0) { console.error('usage: node tools/scroll-export.mjs [bundlesDir] --out <dir>'); process.exit(1) }
const out = resolve(argv[oi + 1])
const ls = (d) => existsSync(d) ? readdirSync(d).sort() : []
const hex = (k) => k.split(':').pop()
let n = 0, hashes = 0
for (const name of ls(dir)) {
  const bd = join(dir, name)
  if (!existsSync(join(bd, 'root.json')) || !existsSync(join(bd, 'chain.json'))) continue
  const chain = JSON.parse(readFileSync(join(bd, 'chain.json'), 'utf8'))
  if (!chain.network || chain.network === 'local') continue
  const root = JSON.parse(readFileSync(join(bd, 'root.json'), 'utf8'))
  const objects = {}
  for (const f of ls(join(bd, 'objects'))) objects['sha256:' + f.replace(/\.cbor$/, '')] = {}
  for (const f of ls(join(bd, 'blobs'))) objects['sha256:' + f.replace(/\.bin$/, '')] = {}
  const edges = []
  for (const f of ls(join(bd, 'edges'))) {
    const e = D.decode(readFileSync(join(bd, 'edges', f)))
    edges.push({ kappa: 'sha256:' + f.replace(/\.cbor$/, ''), source: e.get(0), target: e.get(1), relation: e.get(2) })
  }
  const rootObj = fieldsOf(D.decode(readFileSync(join(bd, 'objects', hex(root.root) + '.cbor'))))
  const minted_on = String(rootObj.minted_at || '').slice(0, 10)
  const od = join(out, name); mkdirSync(od, { recursive: true })
  writeFileSync(join(od, 'root.json'), JSON.stringify({ root_kappa: root.root, merkle: root.merkle, minted_on, leaves: Object.keys(objects).length + edges.length }, null, 2) + '\n')
  writeFileSync(join(od, 'graph.json'), JSON.stringify({ objects, edges }, null, 1) + '\n')
  n++; hashes += Object.keys(objects).length + edges.length + 1
}
console.log(`${n} sealed rounds → ${out} · ${hashes} hashes`)
