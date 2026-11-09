# For an agent working here

Caesura is a NEAR gate contract plus two held-apart seats plus one evidence root per round.
Read README.md first; it is the runnable path. Then:

- `SPEC.md` — the contract interface, the seat prompts, the bundle layout.
- `contract/src/lib.rs` — the gate; `cargo test` runs its unit tests (Linux/WSL/macOS;
  on Windows the native test build wants NASM).
- `seats/round.mjs` — one round end to end; `--chain off` needs no network.
- `tools/verify.mjs` — sees only a bundle; exit 0 is the only pass.
- `bundles/` — sealed rounds. Every bundle here was minted during the hackathon window on the gate
  named in `site/gates.json`; the board at https://caesura.mages.city reads the same chain.

Rules of the house:
1. Never put a prompt, a tool result or a key inside a bundle. Bundles carry hashes and
   receipts; `bundles/<round>/private/` holds the words and is gitignored.
2. The assayer prompt is built from the canonical proposal and the task text only. Do not
   add the proposer's context to it; that is the caesura.
3. Seat keys are function-call keys on the gate's own account. Do not add a full-access key
   to the gate; `tools/deploy.mjs` deletes the only one it ever had.
4. Mainnet, pushes, public flips and the hackathon submission are the person's acts. Show the
   exact payload and wait.
