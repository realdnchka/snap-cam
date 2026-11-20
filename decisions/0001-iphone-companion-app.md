# 0001 — iPhone companion app, talking to the Mac without a server

Status: Accepted (2026-11-21); "Pairing and security" superseded by [0002](0002-pinned-identities-and-app-socket.md)

## Context

SnapCam today drives the iPhone through Continuity Camera (AVFoundation on macOS).
That path is capped by macOS: no real zoom or lens choice (we crop), no focus control,
no rotation info, photos fall back to 1080p, no torch. Research:
`~/Dev/snapcam/research/mac-iphone-apis.md`, `~/Dev/snapcam/research/magnifier-wrapper.md`.

The user rejected hidden/private APIs: we build a normal tool on public frameworks.
Long-term this camera layer may grow into a soldering HUD (vision-only: a camera
over the desk reads boards and instrument screens; diffuse light against solder
glare) and drive a desk light (RGB shelf strip on ESP32 + HomeSpan in Apple Home).

## Decision

Build a small iOS app, **SnapCam for iPhone**, that owns the phone camera and talks to
SnapCam on the Mac directly — no server, no cloud, public APIs only.

### Transport

- **Network.framework + Bonjour.** The iPhone runs an `NWListener` advertising
  `_snapcam._tcp`; the Mac finds it with `NWBrowser` and connects.
- `includePeerToPeer = true` on both sides: works over the shared Wi-Fi and, without
  one, over AWDL (the AirDrop link). USB-C networking is a later option.
- Not used: MultipeerConnectivity (deprecated in the 27 SDKs), CloudKit (a server,
  needs a paid account), Wi-Fi Aware (unavailable on macOS), Bluetooth LE (too slow
  for images; may come back as a wake-up signal).

### Pairing and security

- The Mac shows a QR code with a random 256-bit key and a pairing id; the phone scans it.
- Both sides store the key in the Keychain; every connection is TLS 1.3 with that
  pre-shared key (`sec_protocol_options_add_pre_shared_key`). Unpaired peers can't connect.
- Forget/re-pair from either side.

### Protocol

Length-prefixed frames via `NWProtocolFramer`: 1-byte type, 4-byte length, payload.
Control messages are JSON; images are raw bytes with a JSON header frame.

| Message | Direction | Payload |
|---|---|---|
| `hello` | both | protocol version, device name, app version |
| `caps` | phone → Mac | lenses, zoom range and switch-over points, photo sizes, flash/torch, formats |
| `preview` | phone → Mac | low-res JPEG frame, ~10–15 fps, while the Mac window is open |
| `set` | Mac → phone | live zoom, lens, focus point, exposure bias, torch |
| `capture` | Mac → phone | format (HEIC/JPEG), max size, flash, delay |
| `photo` | phone → Mac | metadata (lens, zoom, orientation, size) + image bytes |
| `error` / `status` | both | code + text |

### iOS app

- SwiftUI, one screen: live preview, pairing state, lens/zoom; keeps the screen awake.
- Works on any iPhone that runs the deployment target: no model is assumed.
  Lenses, zoom range, macro, max photo size, flash/torch are discovered at run time
  and sent in `caps`; the Mac UI shows only what the phone reports.
- `AVCaptureSession` with the best virtual multi-camera device available (real zoom +
  lens switching), `AVCapturePhotoOutput` up to the device's max photo size,
  `AVCaptureDevice.RotationCoordinator` for orientation, torch and flash, focus point.
- iOS doesn't allow camera capture in the background: the app must be open while
  shooting. Fine on the stand/arm over the desk.

### Mac side

- SnapCam (helper app) gets an **iPhone app** source next to Continuity Camera and
  Desk View: same window, preview from `preview` frames, −/+ sends real zoom, click
  sets focus, lens buttons, torch.
- Falls back to Continuity Camera when the phone app isn't reachable.
- The mod's `take_photo` gains optional `lens` and `zoom`; the tool result carries
  the full-res image (downscaled copy for the model, original saved to disk).

### Light hook (later)

`before`/`after` shot hooks run a Shortcut (`shortcuts run "<scene>"`) on the Mac —
e.g. the «белый под пайку» scene on the shelf strip. Later the phone app may set the
scene itself via HomeKit (iOS-only framework).

### Code layout

New repo **`snapcam-app`** in `~/Dev/snapcam/`: Xcode project with the iOS app, the
macOS SnapCam app and a shared Swift package `SnapCamKit` (protocol, framing, pairing).
`snap-cam` stays the Claude Code plugin and launches the Mac app. The current
`helper/SnapCam.swift` moves into `snapcam-app` once the new Mac app covers it.

### Signing

Start with a free Apple ID (personal team): the iPhone build expires every 7 days and
must be reinstalled from Xcode. A paid account ($99/year) gives 1-year builds and
TestFlight; decide after the spike.

## Phases

- **P0 spike.** iOS app advertises, Mac connects, `capture` → full-res `photo` back.
  No TLS yet. Measure: discovery time, transfer time for a 12/48 MP HEIC, AWDL vs Wi-Fi.
- **P1 MVP.** Pairing + TLS-PSK, caps, lens/zoom/flash on capture, Mac window source,
  mod `take_photo` with `lens`/`zoom`, fallback to Continuity Camera.
- **P2 live.** Preview stream, live zoom/focus/torch from the Mac window.
- **P3 light.** Shortcut hooks; HomeKit from the phone once the shelf board exists.
- **P4 HUD groundwork.** Event/frame stream API for the harness, on-device Vision
  (OCR of instrument screens, ArUco) as experiments.

## Consequences

- Real camera control on public APIs; no dependency on macOS Continuity limits.
- A second app to build and sign; the phone app must be in the foreground to shoot.
- Two capture paths to maintain until Continuity Camera can be dropped.

## Resolved (2026-11-21, user)

- Any iPhone model: capabilities at run time, nothing hard-coded per model.
- Repo split as above. The `snap-cam` plugin repo is public.

- Free Apple ID (personal team); the iPhone build is reinstalled every 7 days.
- Development: UI and networking in the iOS Simulator with a fake camera source;
  capture on the real device.
