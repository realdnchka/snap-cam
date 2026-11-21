# 0003 — The Mac is the hub; one camera contract for every surface

Status: Accepted (2026-11-21).

## Context

Controls grew per surface: the Mac inspector, CLI flags and the `take_photo` tool each
carry their own subset, the iPhone screen has no controls and its shutter goes nowhere.
Next come Camera Control, App Intents and the model steering the framing itself
("too far — zoom in"). Without one vocabulary each surface drifts.

## Decision

**Roles.**
- SnapCam for Mac is the hub: identity and pins, originals, the inbox, the CLI socket,
  all processing (OCR, local models), any future network service.
- The iPhone is a camera head: pairing, viewfinder, framing, shutter, delivery to the
  Mac. No history, no processing settings, no network except to the Mac.
- The phone owns the live camera state (lens, zoom, flash); every change is broadcast,
  so all surfaces show the same framing.

**One contract** (`SnapCamKit`): every surface maps its UI onto the same commands.

| Command | Meaning |
|---|---|
| `shoot(options)` | take a full-size photo now; it lands on the Mac |
| `frame(lens?, zoom?)` | change the live framing without shooting |
| `flash(mode)` | off / on / auto for the next shots |
| `exposure(bias)` | exposure compensation, EV |
| `peek(size)` | one current frame, not saved — to check framing |
| `live(on)` | preview video stream to the Mac while someone watches |
| `state` | caps (lenses, zoom range, sizes) + current framing |
| `inbox(n)` | photos shot from the phone, oldest first; taking them clears them |

Capability limits come from the phone's caps at run time, never from a model list.

**Phone shutter.** A shot from the phone goes to the Mac inbox. If the Mac is away the
phone keeps it and resends on reconnect; it deletes only after the Mac acknowledges.
The mod shows inbox photos in the tray above the prompt.

**Processing.** Local only for now: Vision OCR, Apple Foundation Models, App Intents.
Heavy work runs on the Mac; the phone runs only real-time viewfinder helpers (text or
document highlight). A server is a later, separate decision.

**Camera Control** (amended 2026-11-21): full press = `shoot`; on the button the system
zoom slider (`frame`, lenses switch by themselves), a flash picker (`flash`) and the
system exposure slider (`exposure`). Availability and slot count come from
`supportsControls` / `maxControlsCount`. Lock-screen capture (`LockedCameraCapture`) feeds
the inbox later.

**Live video** (amended 2026-11-21): the phone sends one H.264/HEVC preview stream
(VideoToolbox) only while a viewer is open. The Mac app shows it natively; the Claude
pane gets a few frames per second from the Mac; `peek` is one frame. The Mac may enhance
it for people (VideoToolbox low-latency super resolution, frame interpolation, noise
filter, checked at run time). Enhanced pixels are for eyes only: `peek`, OCR and any
model input use raw frames or real photos.

**Continuity Camera** fallback is secondary; no new work on it beyond the helper's look.

## Tool matrix

Generated (amended 2026-11-21): the source of truth is `SnapCamKit/Contract.swift`; it
renders to snapcam-app `docs/camera-contract.md` (`snapcam-cli contract --markdown`) and to
`contract.ts` in this repo (`--ts`; `--json` for other tools). Copy for readers:

<!-- contract:begin -->
✅ works now · 🔜 planned · — not applicable

| Command | Mac app | iPhone screen | Camera Control | Claude pane | CLI | MCP | App Intents |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shoot | ✅ iPhone or a Mac camera, source picker | ✅ shutter; to the Mac inbox | ✅ full press | 🔜 button | ✅ `capture`, `capture --source` | ✅ `take_photo camera` | 🔜 «Снять фото» |
| frame: lens | ✅ inspector, live | ✅ lens buttons | ✅ system zoom slider switches lenses | 🔜 | ✅ `frame --lens`, `capture --lens` | ✅ `frame lens`, `take_photo lens` | 🔜 |
| frame: zoom | ✅ inspector, live | ✅ pinch, slider | ✅ system slider | 🔜 | ✅ `frame --zoom`, `capture --zoom` | ✅ `frame zoom`, `take_photo zoom` | 🔜 |
| flash | ✅ inspector, live; on = light | ✅ flash menu; on = light | ✅ picker | 🔜 | ✅ `flash`, `capture --flash` | ✅ `take_photo flash`; on = light | 🔜 |
| light | ✅ inspector brightness, live | ✅ brightness slider while on | ✅ brightness slider | 🔜 | ✅ `light` | ✅ `light level` | 🔜 |
| exposure | ✅ inspector, live | ✅ slider | ✅ system slider | 🔜 | ✅ `exposure` | ✅ `frame exposure` | — |
| live video | ✅ iPhone live view, Mac camera preview | ✅ viewfinder | — | 🔜 few fps | — | — | — |
| peek | ✅ inspector | — | — | 🔜 | ✅ `peek --preview`, `peek --source` | ✅ `peek camera` | — |
| state / caps | ✅ | ✅ | — | 🔜 | ✅ `state`, `caps`, `status` | ✅ `camera_state` | — |
| inbox | — (phone shots go to history; the queue is for Claude) | ✅ offline queue (unsent shots) | — (sends) | ✅ tray; 🔜 gallery | ✅ `inbox`, `inbox --take --id` | — (tray only) | 🔜 |
| recent photos | ✅ history grid | — (last photo only) | — | 🔜 gallery | ✅ `recent` | ✅ `recent_photos count` | 🔜 |
| format / size | ✅ inspector | — | — | — | ✅ `capture --format --size` | — (Mac default) | — |
| pair / forget | ✅ | ✅ | — | — | ✅ `pair` | — | — |
| read text | ✅ history: Read Text | — (the Mac reads) | — | 🔜 | ✅ `ocr`, `ocr --recent` | ✅ `read_text path recent` | ✅ «Read Text in Photo» |
| ask about a photo | ✅ history: Ask | — (the Mac answers) | — | 🔜 | ✅ `ask --question`, `ask --recent` | ✅ `ask_photo question path recent` | 🔜 |
<!-- contract:end -->

## Consequences

- New UI is a new row of buttons over existing commands, not new protocol.
- The model can look (`peek`), adjust (`frame`) and shoot, like a person at the phone.
- Wire protocol gains `frame`, `exposure`, `peek`, `live`, `state` events, a video
  stream and photo push with acks.
- A conformance test keeps every surface honest: SnapCamKit `ContractTests` (every cell
  declared, docs current, CLI cells name real syntax) and `hooks/contract.test.ts` (MCP
  cells name registered tools and `take_photo` inputs).
