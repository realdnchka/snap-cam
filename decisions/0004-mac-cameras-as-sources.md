# 0004 — Mac cameras become sources in SnapCam for Mac; the plugin helper goes

Status: Accepted (2026-11-21). Supersedes the Continuity fallback in 0002 and 0003.

## Context

The plugin builds its own Continuity/Desk View helper app with `swiftc` and ad-hoc
signing. It is a second capture path outside the camera contract: its own flags, its own
quirks, a fresh camera permission after every rebuild, Sidecar conflicts. Its one
advantage is that it needs neither of our apps.

## Decision

- SnapCam for Mac gets camera sources besides the iPhone app: Continuity Camera, Desk
  View and the Mac's built-in camera, all through AVFoundation on macOS.
- A source states what it can do through the same caps; the contract and its surfaces
  do not change. Mac sources are "plain photo + live video": shoot, crop zoom, flash
  where the device has it, live video and `peek`. No lens or exposure control.
- The plugin talks only to `snapcam-cli`. The helper, its build step and exit-69
  fallback to it are removed; without the Mac app the plugin says how to install it.
- Distribution to people outside the team (paid Developer ID, notarization, App Store)
  is a separate decision; until then the apps are built from source.

## Consequences

- One capture path and one matrix; the source dimension lives in caps only.
- Strangers can no longer use the plugin with Continuity alone until the Mac app is
  distributable.
- Continuity limits stay (≤1920×1440, crop zoom, Sidecar contention, no rotation info,
  the iPhone can't be our app's camera and Continuity's at once).
