#!/usr/bin/env node
// registry.mjs — the registry of gates (registry/): deploy it, register a gate you own, list, unregister.
//
//   node tools/registry.mjs deploy     --owner caesura.testnet [--registry gates.caesura.testnet] [--fund 3]
//   node tools/registry.mjs register   <gate> --owner <you>.testnet [--label "your gate"] [--registry gates.caesura.testnet]
//   node tools/registry.mjs unregister <gate> --owner <you>.testnet [--registry gates.caesura.testnet]
//   node tools/registry.mjs list       [--registry gates.caesura.testnet]
//
// `register` attaches 0.01 NEAR for the entry's storage. The registry asks the gate for its owner
// and keeps the entry only if that is the caller; otherwise the deposit comes back and the
// refusal is an event. Credentials: ~/.near-credentials/<network>/<owner>.json.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js'
import { RPC, view } from '../lib/chain.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const network = opt('network', 'testnet')
const registryId = opt('registry', process.env.CAESURA_REGISTRY || 'gates.caesura.testnet')
const TGAS = (n) => BigInt(n) * 1_000_000_000_000n
const NEAR = 10n ** 24n
const near = (n) => BigInt(Math.round(n * 1000)) * NEAR / 1000n
const usage = () => { console.error('usage: node tools/registry.mjs deploy|register <gate>|unregister <gate>|list [--owner <account>] [--registry <id>] [--label <text>]'); process.exit(1) }
if (!cmd) usage()

const events = (outcome) => [outcome.transaction_outcome, ...(outcome.receipts_outcome || [])]
  .flatMap(o => o?.outcome?.logs || []).filter(l => l.startsWith('EVENT_JSON:')).map(l => JSON.parse(l.slice(11)))

if (cmd === 'list') {
  const rows = await view(registryId, 'list_gates', { from: 0, limit: 100 }, network)
  if (!rows.length) console.log(`no gates registered on ${registryId}`)
  for (const e of rows) console.log(`${e.gate}  owner ${e.owner}  "${e.label}"  registered by ${e.registered_by} at ${new Date(e.registered_at_ms).toISOString()}`)
  process.exit(0)
}

const ownerId = opt('owner'); if (!ownerId) { console.error('--owner <account> is required'); usage() }
const credPath = join(homedir(), '.near-credentials', network, ownerId + '.json')
if (!existsSync(credPath)) { console.error('no credentials at ' + credPath); process.exit(1) }
const cred = JSON.parse(readFileSync(credPath, 'utf8'))
const provider = new JsonRpcProvider({ url: RPC[network] })
const owner = new Account(ownerId, provider, cred.private_key)

if (cmd === 'deploy') {
  const fund = Number(opt('fund', '3'))
  const wasm = readFileSync(opt('wasm', 'registry/target/wasm32-unknown-unknown/release/caesura_registry.wasm'))
  try { await provider.viewAccount({ accountId: registryId }); console.error(`${registryId} already exists`); process.exit(1) } catch {}
  // the registry stays upgradable by its owner: the owner's own key is its full-access key
  const ownerKey = KeyPair.fromString(cred.private_key).getPublicKey()
  const tx = await owner.signAndSendTransaction({
    receiverId: registryId,
    actions: [
      actions.createAccount(),
      actions.transfer(near(fund)),
      actions.addFullAccessKey(ownerKey),
      actions.deployContract(wasm),
      actions.functionCall('new', { owner: ownerId }, TGAS(30), 0n),
    ],
  })
  console.log(`registry ${registryId} created + deployed + initialised · ${wasm.length} B · owner ${ownerId} · tx ${tx.transaction.hash}`)
  process.exit(0)
}

const gateId = argv[1]; if (!gateId || gateId.startsWith('--')) usage()

const send = async (tx) => { try { return await owner.signAndSendTransaction(tx) } catch (e) { const m = /"ExecutionError":"([^"]+)"/.exec(JSON.stringify(e.context || e.message || e)); console.error('refused by the registry: ' + (m ? m[1].replace(/Smart contract panicked: /, '') : e.message)); process.exit(2) } }

if (cmd === 'register') {
  const label = opt('label', gateId)
  const outcome = await send({
    receiverId: registryId,
    actions: [actions.functionCall('register', { gate: gateId, label }, TGAS(60), near(0.01))],
  })
  const ev = events(outcome)
  const reg = ev.find(e => e.event === 'register'), ref = ev.find(e => e.event === 'refused')
  if (reg) console.log(`registered ${gateId} on ${registryId} · owner ${reg.data.owner} · "${reg.data.label}" · tx ${outcome.transaction.hash}`)
  else if (ref) { console.error(`refused: ${ref.data.reason} · tx ${outcome.transaction.hash}`); process.exit(2) }
  else { console.error('no register event in the outcome'); console.error(JSON.stringify(outcome.status)); process.exit(2) }
} else if (cmd === 'unregister') {
  const outcome = await send({
    receiverId: registryId,
    actions: [actions.functionCall('unregister', { gate: gateId }, TGAS(30), 0n)],
  })
  const ev = events(outcome).find(e => e.event === 'unregister')
  if (ev) console.log(`unregistered ${gateId} · tx ${outcome.transaction.hash}`); else { console.error(JSON.stringify(outcome.status)); process.exit(2) }
} else usage()
