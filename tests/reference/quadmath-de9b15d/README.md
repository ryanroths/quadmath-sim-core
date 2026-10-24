# Frozen quadmath plant code (reference for P2 and P3)

These three files are quadmath's own, copied byte for byte from
`ryanroths/quadmath` `origin/main` at `de9b15d` (`git show de9b15d:<file>`).
They are the reference the port-parity tests run against: sim-core's C plant
in its parity model gets the same motor commands (P2) or the same battery load
sequence (P3), and must match within 1e-6 relative. Do not edit them; a new
reference is a new directory named for its commit.

| File | sha256 |
|---|---|
| `quadphysics.js` | `e1f4656416350855e2bc6df43f771f732d62697ffc593f1ac199b079e077a728` |
| `sim-whoop.js` | `c5a4d163f20f3e138591168fd7bfe618f0af8ccded5b47b20234ed13bd2bf15f` |
| `sim-build.js` | `fa0942d7ccfbfcb9f3181a4ea7830fbfb9618abc7f36988d5f99bd0ee5e366c7` |

Copying them here follows the Phase 1 plan's decision 13 ("a frozen copy of
the JS plant in this GPL repo as the P2 reference"), taken 2026-10-22 at medium
confidence because it is the owner's licensing call (PROGRESS.md).
