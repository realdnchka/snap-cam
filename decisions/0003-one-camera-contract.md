# 0003 — The Mac is the hub; one camera contract for every surface

Status: Proposed (2026-11-21).

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
| `peek(size)` | small current frame, not saved — to check framing |
| `state` | caps (lenses, zoom range, sizes) + current framing |
| `inbox(n)` | photos shot from the phone, oldest first; taking them clears them |

Capability limits come from the phone's caps at run time, never from a model list.

**Phone shutter.** A shot from the phone goes to the Mac inbox. If the Mac is away the
phone keeps it and resends on reconnect; it deletes only after the Mac acknowledges.
The mod shows inbox photos in the tray above the prompt.

**Processing.** Local only for now: Vision OCR, Apple Foundation Models, App Intents.
Heavy work runs on the Mac; the phone runs only real-time viewfinder helpers (text or
document highlight). A server is a later, separate decision.

**Continuity Camera** fallback is secondary; no new work on it beyond the helper's look.

## Tool matrix

✅ works now · 🔜 planned · — not applicable

| Command | Mac app | iPhone screen | Camera Control | CLI | MCP `take_photo` & co | App Intents |
|---|---|---|---|---|---|---|
| shoot | ✅ | 🔜 | 🔜 press | ✅ `capture` | ✅ `take_photo` | 🔜 «Снять фото» |
| frame: lens | ✅ inspector | 🔜 | 🔜 picker | ✅ `--lens` | ✅ per shot; 🔜 `frame` | 🔜 |
| frame: zoom | ✅ inspector | 🔜 pinch | 🔜 slider | ✅ `--zoom` | ✅ per shot; 🔜 `frame` | 🔜 |
| flash | ✅ inspector | 🔜 | — | ✅ `--flash` | ✅ | 🔜 |
| peek | 🔜 live preview | ✅ viewfinder | — | 🔜 `peek` | 🔜 `peek` | — |
| state / caps | ✅ | ✅ | — | ✅ `caps`, `status` | 🔜 `camera_state` | — |
| inbox | 🔜 | — (sends) | — (sends) | 🔜 `inbox` | 🔜 `take_inbox` | 🔜 |
| format / size | ✅ inspector | — | — | ✅ | — (Mac default) | — |
| pair / forget | ✅ | ✅ | — | ✅ `pair` | — | — |

## Consequences

- New UI is a new row of buttons over existing commands, not new protocol.
- The model can look (`peek`), adjust (`frame`) and shoot, like a person at the phone.
- Wire protocol gains `frame`, `peek`, `state` events and photo push with acks.
