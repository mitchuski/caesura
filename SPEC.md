# Caesura — interface spec (v1, NEAR Hackathon build, November 2026)

One NEAR contract (the gate), two seats (proposer, assayer), one evidence bundle per round.

## Accounts and keys

- `gate` = the contract account, e.g. `pause.caesura.testnet`. After deploy the owner removes
  its full-access key, so only the contract's code and its scoped keys can act on it.
- Two function-call access keys live ON the gate account, added by the contract itself
  (`set_seat_keys` issues `add_access_key_allowance` on `env::current_account_id()`):
  - proposer key: `receiver_id = gate`, `method_names = ["propose"]`, allowance 0.25 NEAR gas
  - assayer key: `receiver_id = gate`, `method_names = ["assay", "commit_root"]`
- The contract authorises a call by `env::signer_account_pk()` (which key signed), while the
  protocol already refuses any other method for that key.
- Owner = a NEAR account (person or Sputnik DAO). Owner methods check `predecessor_account_id`.

## Types

```
Policy      { max_per_action: U128, max_per_day: U128, cooldown_ms: u64,
              receivers: Vec<AccountId>, methods: Vec<String> }   // methods: allowed fn names; "" = plain transfer
Action      { receiver_id: AccountId, method_name: Option<String>, args_base64: Option<String>,
              deposit: U128, gas_tgas: Option<u64> }
Receipt     { model: String, request_hash: String, response_hash: String,
              signing_address: String, signature: String, signature_kind: String, signing_algo: String }
Verdict     { approve: bool, reason: String, assay_kappa: String, receipt: Receipt }
Proposal    { id: u64, action, proposal_kappa: String, receipt: Receipt, proposed_at_ms: u64,
              status: "proposed"|"executed"|"refused"|"failed", verdict: Option<Verdict>,
              refusal: Option<String>, executed_at_ms: Option<u64>, root: Option<String> }
RootRecord  { proposal_id: u64, round: String, root: String, committed_at_ms: u64 }
```

## Methods

| method | who | effect |
|---|---|---|
| `new(owner, policy)` | init | state |
| `propose(action, proposal_kappa, receipt) -> u64` | proposer key | stores Proposal(status proposed); event `propose` |
| `assay(id, verdict) -> String` | assayer key | policy check; approve+pass → Promise (transfer or function_call) + callback; else status refused with reason; event `assay` |
| `commit_root(id, round, root)` | assayer key or owner | stores RootRecord, sets proposal.root; event `root` |
| `set_policy(policy)` | owner | replace policy; event `policy` |
| `set_paused(bool)` | owner | pause/unpause; event `pause` |
| `set_seat_keys(proposer_pk, assayer_pk)` | owner | deletes old seat keys if any, adds the two scoped keys on the gate account; event `keys` |
| `on_executed(id)` | private callback | marks executed or failed from the promise result |
| views | anyone | `get_policy`, `get_state`, `get_proposal(id)`, `list_proposals(from,limit)`, `list_roots(from,limit)` |

Policy check order at assay (first failure is the refusal reason):
`paused` · `verdict` (assayer said no) · `receiver` · `method` · `cap_action` · `cap_day` · `cooldown`.

Events: NEP-297 `EVENT_JSON:{"standard":"caesura","version":"1.0.0","event":..., "data":{...}}`.

## Seats (Node, in `seats/`)

- `propose`: prompt = task + policy summary + tool results (may be poisoned). Model returns
  JSON `{ action, rationale }`. Canonical proposal bytes = dCBOR of `{ action, task_id }`;
  `proposal_kappa = sha256:<hex>` of those bytes. The receipt is fetched from NEAR AI Cloud
  (`GET /v1/signature/{id}`) when the driver is `nearai`; the stub driver writes a stub receipt
  marked `signature_kind: "stub"`.
- `assay`: prompt = canonical proposal + policy summary + the original task text ONLY (never
  the proposer's prompt or tool results). Model returns `{ approve, reason }`.
- Drivers: `stub` (deterministic, no network), `nearai` (OpenAI-compatible chat completions at
  `https://cloud-api.near.ai/v1`, exact-bytes hashing, signature + attestation fetch).

## Seat signatures and the ceremony (optional, `lib/hybrid.mjs`, `round.mjs --sign`)

Each key may sign what it produced with a suite that is data: `ed25519` (the NEAR key alone),
`mldsa65-ed25519` (ML-DSA-65 + the same ed25519 key; both must verify) or
`slhdsa-sha2-128s-ed25519` (SLH-DSA-SHA2-128s + ed25519; both must verify). Message:
`"CompositeAlgorithmSignatures2025" ‖ "caesura/sig/<suite>/1" ‖ 0x00 ‖ PH(M)` with `PH(M)[2i] =
SHA-256(M)[i]`, `PH(M)[2i+1] = SHA3-256(M)[i]` (64 bytes). `M` = the canonical proposal bytes
(proposer), the canonical verdict bytes `dCBOR{0: "caesura/verdict-canon/1", 1: proposal_kappa,
2: approve, 3: reason}` (assayer), or the canonical `ceremony/1` bytes (owner, and the keys a
transfer leaves). Leaves: `key-policy/1 {proposer_suite, assayer_suite, owner_suite?}`;
`seat-key/1 {seat, suite, ed25519_pub, pq_pub_kappa}` (its address is the key commitment; the pq
public key is a blob); `sig/1 {seat, suite, key_kappa, message_kappa, prehash, ed25519_sig(hex),
pq_sig_kappa}` (the pq signature is a blob); `ceremony/1 {kind: seat-keys|transfer, issued_at,
key_policy_kappa, proposer_key_kappa, assayer_key_kappa, owner_key_kappa,
previous_ceremony_kappa, previous_proposer_key_kappa, previous_assayer_key_kappa}`. Edges:
`proposal|verdict|ceremony → sig` certified-by, `sig → seat-key` refers-to, `ceremony →
key-policy|seat-key` refers-to, `sig|seat-key → blob` evidence-provenance. The verifier
re-verifies every `sig/1` over the bytes it names, enforces the key policy on the round's own
signatures and the owner's suite on the ceremony, requires the ceremony to name the round's key
policy and keys, requires every transfer to name what it leaves and to be countersigned by each
key it leaves; with `--rpc` it checks the seat halves against the gate's seat keys and the
owner's half against the owner account's full-access keys.

## Evidence bundle (per round, in `bundles/<round>/`)

Objects (dCBOR, κ = sha256 over canonical dCBOR, same axis as the public harness):
`task/1`, `policy/1`, `proposal/1` (+ blob of canonical bytes), `receipt/1` ×2, `verdict/1`,
`chain/1` (tx hash, gate account, status, block), `ledger/1` (composed-of all), `root/1`.
Edges: `derived-from`, `evidence-provenance`, `composed-of`. `root.json` carries the run root
(= κ of the root object) and the merkle root over every leaf. `commit_root(id, round, root)`
puts the run root on-chain.

Verifier (`tools/verify.mjs <bundleDir> [--rpc testnet]`) sees only the bundle: re-hashes
every object and blob, walks composed-of from the root, re-derives `proposal_kappa` from the
canonical blob, verifies each receipt's signature (ed25519 over the receipt text with the
attested signing key; stub receipts are reported as such, never as verified), and, with
`--rpc`, reads the gate's `list_roots` and matches the root. Exit 0 only when all hold.
