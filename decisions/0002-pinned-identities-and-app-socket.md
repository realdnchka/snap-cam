# 0002 — Pinned device identities instead of TLS-PSK; the CLI goes through the Mac app

Status: Accepted (2026-11-21). Supersedes the "Pairing and security" part of 0001.

## Context

0001 planned TLS 1.3 with a pre-shared key from a QR code. Checked against the 27.2 SDK
and a loopback test: the new Network `TLS` builder has no PSK, and Apple's TLS 1.3 has no
external PSK (handshake fails); PSK works only as TLS 1.2 with an undocumented cipher-suite
cast, without forward secrecy. Also, with a free team the Mac app has no provisioning
profile and a bare command-line tool can't carry keychain entitlements.

## Decision

- Each device has its own P-256 key and a self-signed certificate. Connections are
  TLS 1.3 with mutual authentication; each side pins the peer's key fingerprint.
- Pairing: the Mac shows a 100-bit code (QR / `snapcam://pair` link / typed). After TLS,
  both sides prove the code with HMAC over both fingerprints, then store the pin.
  Forget from either side; the other then sees "forgot this Mac — pair again".
- SnapCam for Mac owns the identity, pins and phone connection. `snapcam-cli` (in
  `SnapCam.app/Contents/Helpers`) is a thin client over a Unix socket in
  `~/Library/Application Support/SnapCam/`; the Claude Code mod calls the CLI and falls
  back to Continuity Camera on exit 69.

## Consequences

- Forward secrecy and only documented APIs; a small DER writer for one certificate shape.
- One phone connection per Mac; mod shots also appear in the Mac app's history.
- Details: `snapcam-app/docs/p1-plan.md`.
