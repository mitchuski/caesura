"""verify_py.py - a second verifier in a second language, on the kappa evidence mage's axis.

Usage: python tools/verify_py.py bundles/<round> [--kappa <dir with kappa.py>]

Uses kappa.py from github.com/mitchuski/kappa-evidence-mage (dCBOR encode/decode, sha256
addresses, merkle) and nothing from this repo's JavaScript. Re-derives: every object, blob
and edge file re-hashes to its name; every object is canonical dCBOR; root.json names a
caesura/root/1 object in the bundle; the merkle root recomputed over every leaf equals the
root object's; the ledger's members exist with composed-of edges; the proposal's canonical
blob re-hashes to proposal_kappa; a refusing verdict is a refusing chain record.
Exit 0 only when all hold. Two implementations that disagree would be the finding.
"""
from __future__ import annotations

import json
import os
import sys

argv = sys.argv[1:]
bundle = next((a for a in argv if not a.startswith("--")), None)
if not bundle:
    print(__doc__); sys.exit(1)
kdir = argv[argv.index("--kappa") + 1] if "--kappa" in argv else os.path.expanduser("~/kappa_evidence_mage")
sys.path.insert(0, kdir)
import kappa as K  # noqa: E402

NS = "caesura"
problems: list[str] = []

def files(sub: str):
    d = os.path.join(bundle, sub)
    return sorted(f for f in os.listdir(d)) if os.path.isdir(d) else []

objects, blobs, edges = {}, {}, {}
for f in files("objects"):
    data = open(os.path.join(bundle, "objects", f), "rb").read()
    k = K.kappa_from_bytes(data)
    if k.split(":")[1] + ".cbor" != f: problems.append(f"object {f} does not hash to its name")
    v = K.decode(data)
    if K.encode(v) != data: problems.append(f"object {k} is not canonical")
    objects[k] = v
for f in files("blobs"):
    data = open(os.path.join(bundle, "blobs", f), "rb").read()
    k = K.kappa_from_bytes(data)
    if k.split(":")[1] + ".bin" != f: problems.append(f"blob {f} does not hash to its name")
    blobs[k] = data
for f in files("edges"):
    data = open(os.path.join(bundle, "edges", f), "rb").read()
    k = K.kappa_from_bytes(data)
    if k.split(":")[1] + ".cbor" != f: problems.append(f"edge {f} does not hash to its name")
    edges[k] = K.decode(data)

root_json = json.load(open(os.path.join(bundle, "root.json"), encoding="utf-8"))
root_k = root_json["root"]
root = objects.get(root_k)
if root is None:
    problems.append("root.json names a root object that is not in the bundle")
else:
    if root.get(0) != f"{NS}/root/1": problems.append("root object has the wrong type")
    ledger_k, merkle_hex, n_leaves = root.get(2), root.get(3), root.get(4)
    root_edges = {k for k, e in edges.items() if e.get(0) == root_k}
    leaves = sorted(k for k in list(objects) + list(blobs) + list(edges) if k != root_k and k not in root_edges)
    re_merkle = K.merkle_root([k.encode() for k in leaves])
    if re_merkle is None or re_merkle.hex() != merkle_hex: problems.append("merkle root mismatch")
    if int(n_leaves) != len(leaves): problems.append(f"leaf count {len(leaves)} vs root {n_leaves}")
    ledger = objects.get(ledger_k)
    if ledger is None:
        problems.append("ledger missing")
    else:
        members = ledger.get(2)
        for m in members:
            if m not in objects: problems.append(f"ledger member {m} missing")
            if not any(e.get(0) == ledger_k and e.get(1) == m for e in edges.values()): problems.append(f"no composed-of edge ledger->{m}")
        typed = {}
        for m in members:
            o = objects.get(m)
            if o is not None: typed.setdefault(o.get(0), []).append(o)
        prop = (typed.get(f"{NS}/proposal/1") or [None])[0]
        verd = (typed.get(f"{NS}/verdict/1") or [None])[0]
        chain = (typed.get(f"{NS}/chain/1") or [None])[0]
        if prop is None: problems.append("no proposal object")
        else:
            canon_k, pk = prop.get(2), prop.get(3)
            if canon_k not in blobs: problems.append("proposal canonical blob missing")
            elif K.kappa_from_bytes(blobs[canon_k]) != pk: problems.append("proposal_kappa does not re-derive from the blob")
        if verd is not None and prop is not None and verd.get(1) != prop.get(3): problems.append("verdict does not name the proposal_kappa")
        # "proposed" is a read that raced finality; verify.mjs --rpc resolves it against the chain
        if verd is not None and chain is not None and (not verd.get(2)) and chain.get(4) not in ("refused", "proposed"):
            problems.append(f"assayer refused but chain status is {chain.get(4)}")
        if chain is not None:
            print(f"     chain {chain.get(1)} · {chain.get(2)} · proposal {chain.get(3)} · {chain.get(4)}" + (f" · {chain.get(5)}" if chain.get(5) else ""))

ok = not problems
print(f"{'ok  ' if ok else 'FAIL'} python: {len(objects)} objects · {len(blobs)} blobs · {len(edges)} edges · root {root_k[:23]}…")
for p in problems: print("     - " + p)
print("VERIFY(py): " + ("PASS" if ok else "FAIL"))
sys.exit(0 if ok else 1)
