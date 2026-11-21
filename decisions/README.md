# Decision log

One decision per file, `NNNN-short-slug.md`, numbered in order; never renumber.
A decision changes only through a new record that supersedes it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-iphone-companion-app.md) | iPhone companion app over Network.framework + Bonjour (P2P), no server, public APIs only | Accepted; security part superseded by 0002 |
| [0002](0002-pinned-identities-and-app-socket.md) | Pinned per-device TLS 1.3 identities instead of PSK; the CLI talks to the Mac app over a Unix socket | Accepted |
| [0003](0003-one-camera-contract.md) | The Mac is the hub, the iPhone a camera head; one camera contract and tool matrix for every surface | Proposed |
