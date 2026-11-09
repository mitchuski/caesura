// chain.mjs — the gate on NEAR, through near-api-js v7.
//
// A seat signs with its own function-call key ON the gate account: the account id is the
// gate's, the private key is the seat's. The protocol refuses any method that key is not
// scoped to; the contract checks which key signed.

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js'

export const RPC = {
  testnet: process.env.NEAR_RPC_TESTNET || 'https://test.rpc.fastnear.com',
  mainnet: process.env.NEAR_RPC_MAINNET || 'https://free.rpc.fastnear.com',
}

export function provider(network = 'testnet') { return new JsonRpcProvider({ url: RPC[network] || network }) }

export function seatAccount(gateId, seatPrivateKey, network = 'testnet') {
  return new Account(gateId, provider(network), seatPrivateKey)
}

export function ownerAccount(ownerId, ownerPrivateKey, network = 'testnet') {
  return new Account(ownerId, provider(network), ownerPrivateKey)
}

const TGAS = (n) => BigInt(n) * 1_000_000_000_000n

export async function view(gateId, method, args = {}, network = 'testnet') {
  return provider(network).callFunction({ contractId: gateId, method, args })
}

async function call(account, gateId, methodName, args, gasTgas = 50, deposit = 0n) {
  const out = await account.callFunction({ contractId: gateId, methodName, args, gas: TGAS(gasTgas), deposit })
  return out
}

// callFunction returns the parsed result; we also want the tx hash and logs, so use the raw path.
async function callRaw(account, gateId, methodName, args, gasTgas = 50, deposit = 0n) {
  const outcome = await account.signAndSendTransaction({
    receiverId: gateId,
    actions: [actions.functionCall(methodName, args, TGAS(gasTgas), deposit)],
  })
  const txHash = outcome.transaction?.hash || outcome.transaction_outcome?.id
  const logs = [outcome.transaction_outcome, ...(outcome.receipts_outcome || [])].flatMap(o => o?.outcome?.logs || [])
  const status = outcome.status
  let value = null
  if (status && typeof status === 'object' && 'SuccessValue' in status && status.SuccessValue) {
    try { value = JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString()) } catch { value = Buffer.from(status.SuccessValue, 'base64').toString() }
  }
  const failure = status && typeof status === 'object' && 'Failure' in status ? status.Failure : null
  return { txHash, logs, value, failure, outcome }
}

export const gate = {
  propose: (seat, gateId, action, proposal_kappa, receipt) => callRaw(seat, gateId, 'propose', { action, proposal_kappa, receipt }, 30),
  assay: (seat, gateId, id, verdict) => callRaw(seat, gateId, 'assay', { id, verdict }, 100),
  commitRoot: (seat, gateId, id, round, root) => callRaw(seat, gateId, 'commit_root', { id, round, root }, 30),
  setPolicy: (owner, gateId, policy) => callRaw(owner, gateId, 'set_policy', { policy }, 30),
  setPaused: (owner, gateId, paused) => callRaw(owner, gateId, 'set_paused', { paused }, 30),
  setSeatKeys: (owner, gateId, proposer_key, assayer_key) => callRaw(owner, gateId, 'set_seat_keys', { proposer_key, assayer_key }, 60),
  state: (gateId, network) => view(gateId, 'get_state', {}, network),
  policy: (gateId, network) => view(gateId, 'get_policy', {}, network),
  proposal: (gateId, id, network) => view(gateId, 'get_proposal', { id }, network),
  roots: (gateId, network, from = 0, limit = 50) => view(gateId, 'list_roots', { from, limit }, network),
}

// an account's access keys (full-access and function-call), as the RPC lists them
export async function accessKeys(accountId, network = 'testnet') {
  const r = await provider(network).query({ request_type: 'view_access_key_list', finality: 'final', account_id: accountId })
  return r.keys || []
}
export function newSeatKey() { const kp = KeyPair.fromRandom('ed25519'); return { publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() } }

export { KeyPair, KeyPairSigner, actions }
export const _call = call
