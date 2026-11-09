#!/usr/bin/env node
// deploy.mjs — stand the gate up on testnet, then lock it.
//
//   node tools/deploy.mjs --owner caesura.testnet [--gate gate.caesura.testnet] [--fund 5] [--policy tasks/policy.json]
//
// 1. create the gate sub-account with a temporary full-access key and <fund> NEAR
// 2. deploy contract/target/wasm32-unknown-unknown/release/caesura_gate.wasm and call new(owner, policy)
// 3. create the policy's receiver sub-accounts that do not exist yet (0.1 NEAR each)
// 4. generate two seat keys; owner calls set_seat_keys → the contract adds them to its own
//    account as function-call keys scoped to propose / assay,commit_root
// 5. delete the temporary full-access key: from here only the code and the two seats act
// 6. write .env.caesura (gitignored) with the gate id and the two seat keys
//
// Owner credentials: ~/.near-credentials/testnet/<owner>.json (near-cli-rs legacy keychain).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js'
import { RPC, gate as g, newSeatKey, view } from '../lib/chain.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const network = opt('network', 'testnet')
const ownerId = opt('owner'); if (!ownerId) { console.error('--owner <account> is required'); process.exit(1) }
const gateId = opt('gate', `gate.${ownerId}`)
const fund = Number(opt('fund', '5'))
const policyPath = opt('policy', 'tasks/policy.json')
const wasmPath = opt('wasm', 'contract/target/wasm32-unknown-unknown/release/caesura_gate.wasm')

const credPath = join(homedir(), '.near-credentials', network, ownerId + '.json')
if (!existsSync(credPath)) { console.error('no owner credentials at ' + credPath); process.exit(1) }
const cred = JSON.parse(readFileSync(credPath, 'utf8'))
const provider = new JsonRpcProvider({ url: RPC[network] })
const owner = new Account(ownerId, provider, cred.private_key)
const NEAR = 10n ** 24n
const near = (n) => BigInt(Math.round(n * 1000)) * NEAR / 1000n
const TGAS = (n) => BigInt(n) * 1_000_000_000_000n
const log = (m) => console.log('  ' + m)
const exists = async (id) => { try { await provider.viewAccount({ accountId: id }); return true } catch { return false } }

const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
const yocto = (n) => (BigInt(Math.round(n * 1e6)) * NEAR / 1_000_000n).toString()
const policyOnChain = { max_per_action: yocto(policy.max_per_action_near), max_per_day: yocto(policy.max_per_day_near), cooldown_ms: policy.cooldown_ms, receivers: policy.receivers, methods: policy.methods }

console.log(`caesura deploy · ${network} · owner ${ownerId} · gate ${gateId}`)

// 1 + 2: create, deploy, init in one batch (all actions target the new sub-account)
const temp = KeyPair.fromRandom('ed25519')
const wasm = readFileSync(wasmPath)
if (await exists(gateId)) { console.error(`${gateId} already exists; choose --gate <fresh sub-account>`); process.exit(1) }
const created = await owner.signAndSendTransaction({
  receiverId: gateId,
  actions: [
    actions.createAccount(),
    actions.transfer(near(fund)),
    actions.addFullAccessKey(temp.getPublicKey()),
    actions.deployContract(wasm),
    actions.functionCall('new', { owner: ownerId, policy: policyOnChain }, TGAS(30), 0n),
  ],
})
log(`created + deployed + initialised · tx ${created.transaction.hash}`)

// 3: receivers
for (const r of policy.receivers) {
  if (await exists(r)) { log(`receiver ${r} exists`); continue }
  if (!r.endsWith('.' + ownerId)) { log(`receiver ${r} is not a sub-account of the owner; create it yourself`); continue }
  const tx = await owner.signAndSendTransaction({ receiverId: r, actions: [actions.createAccount(), actions.transfer(near(0.1)), actions.addFullAccessKey(KeyPair.fromRandom('ed25519').getPublicKey())] })
  log(`receiver ${r} created · tx ${tx.transaction.hash}`)
}

// 4: seat keys, installed by the contract on its own account
const proposer = newSeatKey(); const assayer = newSeatKey()
const sk = await g.setSeatKeys(owner, gateId, proposer.publicKey, assayer.publicKey)
if (sk.failure) { console.error('set_seat_keys failed', JSON.stringify(sk.failure)); process.exit(2) }
log(`seat keys installed · tx ${sk.txHash}`)

// 5: lock the gate — delete the temporary full-access key
const gateTemp = new Account(gateId, provider, temp.toString())
const del = await gateTemp.signAndSendTransaction({ receiverId: gateId, actions: [actions.deleteKey(temp.getPublicKey())] })
log(`temporary full-access key deleted · tx ${del.transaction.hash}`)

const keys = await provider.viewAccessKeyList({ accountId: gateId })
log(`access keys on ${gateId}: ${keys.keys.map(k => `${k.public_key.slice(0, 20)}… ${typeof k.access_key.permission === 'string' ? k.access_key.permission : 'FunctionCall[' + k.access_key.permission.FunctionCall.method_names.join(',') + ']'}`).join(' · ')}`)
const state = await view(gateId, 'get_state', {}, network)
log(`state: owner ${state.owner} · paused ${state.paused} · proposals ${state.proposals}`)

// 6
const env = [`CAESURA_GATE=${gateId}`, `CAESURA_NETWORK=${network}`, `CAESURA_PROPOSER_KEY=${proposer.privateKey}`, `CAESURA_ASSAYER_KEY=${assayer.privateKey}`, `CAESURA_PROPOSER_PUB=${proposer.publicKey}`, `CAESURA_ASSAYER_PUB=${assayer.publicKey}`, '']
writeFileSync('.env.caesura', env.join('\n'))
console.log('wrote .env.caesura (gitignored). Gate is live and locked.')
