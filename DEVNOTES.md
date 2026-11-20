# snap-cam — developer notes (handover, 2026-11-21)

Claude Code mod + tiny macOS app. Lets the user (and the model) take a photo with the
iPhone (Continuity Camera) or Desk View and get it into the session. Built 2026-11-16…19.
Design decisions: `decisions/`.

## Files

| Path | What |
|---|---|
| `.claude-plugin/plugin.json` | manifest; **bump `version` on every change** (now 0.7.0) |
| `hooks/hooks.json` → `hooks/register.tsx` | the mod (Claude Code function hooks API) |
| `types/index.d.ts` | `$.state` contract: `snap-cam.{busy, pending, viewing}` |
| `helper/SnapCam.swift` + `helper/Info.plist` | the camera app, built on first use |
| `README.md` | user-facing summary |

Runtime state (outside the repo): `~/Library/Application Support/snap-cam/`
— `SnapCam.app`, `built.swift` (copy of the source it was built from), `mc/` (module cache),
`last.status` (helper's answer), `{desk,iphone}-zoom.txt`, `flash.txt`, `last-mode.txt`,
`last-shot.txt` (flash requested/sent), `thumbs/`, `previews/` (+ `.json` size sidecar).
Photos: `~/Pictures/ClaudeSnaps/<mode>-<YYYYMMDD-HHMMSS>.jpg`.

## How it works

- **Band above the prompt** (`ui.render AbovePrompt`, desktop/terminal/vscode, not mobile):
  row 1 = tray of pending thumbnails (🔍 opens the preview pane, ✕ drops it); row 2 =
  `📷 iPhone`, `🗂 DeskView`, `⚡ Fast Capture` (last-used camera, auto-shot, delay 0).
- **Shot flow** (`shoot` → `runHelper`): `ensureApp` rebuilds SnapCam when
  `helper/SnapCam.swift` ≠ `built.swift` (swiftc + ad-hoc codesign), `pkill -x SnapCam`,
  then `open -W -n SnapCam.app --args <mode> <out.jpg> <manual|delaySec> <status> [flash]`.
  `open` is deliberate: SnapCam must be its own app for its own camera TCC grant and for
  `NSCameraUseContinuityCameraDeviceType` (without it the iPhone is invisible).
  Result = contents of the status file (the out path on success, else a Russian error).
- **Tray → prompt**: `prompt.submit` appends `📷 <name>` lines to the text and a
  `context` note telling the model to `Read` the paths; `ui.render UserMessage` hides those
  lines and draws thumbnails + 🔍 instead.
- **Preview pane**: `openPreview` makes `previews/<name>` (sips, ≤800 px, shrinks until
  < 90 KB so the inline SVG stays under the 131 072-char `Svg.source` limit) + size json,
  sets `viewing`, `$.ui.open({ id: 'snap-preview' })`; `ui.render Pane` draws it.
- **Model tool** `mcp__snap-cam__take_photo` (`camera`, `delay_seconds` 0–60, default 3,
  `flash`): same window, auto-shot after 1.5 s warm-up + delay; returns
  `result: [{type:'text'}, {type:'image', data, mimeType}]`.
- **`/snap iphone|desk|list`** — `list` prints every camera with focus/torch/flash support.
- **Helper window**: live preview, centred capture frame with dimmed outside; −/+ (keys
  +/−) zoom 1–3× (centred crop, saved per camera at once); iPhone only: flash
  выкл/вкл/авто (saved). Space/Enter/«Снять» shoot, Esc cancels, 10 min timeout.
  Output JPEG long side ≤ 2400 px.

## Facts established on this Mac (MacBook Pro + iPhone)

- **Rotation**: `RotationCoordinator` always reports 0 for Continuity Camera, KVO never
  fires even when the phone is turned. All app-side rotation was removed at the user's
  request — frames are saved as macOS delivers them. Desk View comes pre-straightened.
- **Zoom**: `videoZoomFactor` / `videoMaxZoomFactor` are *unavailable in macOS* (SDK).
  Our zoom is a crop.
- **Focus**: all focus modes and point-of-interest report «нет» on every camera.
- **Torch**: no (`hasTorch` false). **Flash**: yes; photo output supports off/on/auto,
  also after the format switch. `resolvedSettings.isFlashEnabled` is unavailable on macOS,
  so we only log requested/sent. A test shot with `on` looked flash-lit.
- **Resolution**: iPhone photo max 1920×1440 here; `startRunning` re-applies the session
  preset, so the picked format often falls back to 1920×1080. Re-picking after start made
  the preview blink (looked like a crash) — removed; accept 1080p.
- Wireless iPhone can take 10–20 s to appear; helper polls 30 s with a «Ищу iPhone…» hint.
- Two SnapCam instances fight over the camera and one crashes in `capturePhoto` → the mod
  `pkill`s before launching; helper fails cleanly if the photo connection is inactive.
- Every rebuild re-signs ad hoc → macOS may ask camera permission again.

## Mod API gotchas hit

- `tool.call` hook: the model's arguments are **on `e` itself** (beside `tool`), not
  `e.input`. Result must be a string or an array of blocks (not `{content}`).
- Give gating hooks a `.catch`; `next.error.{kind,message}` explains failures.
- `$.process.run` time in flight doesn't count toward a hook's budget.
- State values a drawing reads live in atoms declared in `types/index.d.ts`.

## Install / update procedure (agreed with the user)

Own git repo `~/Dev/snapcam/snap-cam` (moved out of `~/Work/claude-harness` on
2026-11-21), which is also its own local marketplace `snapcam`
(`.claude-plugin/marketplace.json`, plugin source `./`). Plugin id: `snap-cam@snapcam`.
Installed **per folder, scope project** (project settings don't inherit to
subfolders); the local list of install folders lives in the workspace `CLAUDE.md`.
On every change:

1. bump `version` in `.claude-plugin/plugin.json`;
2. `claude plugin validate ~/Dev/snapcam/snap-cam`;
3. `claude plugin marketplace update snapcam`, then in each install folder
   `claude plugin update snap-cam@snapcam --scope project`
   (outside the sandbox: it writes `~/.claude/plugins`);
4. tell the user open sessions need `/reload-plugins`.


## Open / unverified

- Image block in the `take_photo` result: shape accepted? does the model see the image?
  (0.5.4 changed to array; not re-tested.)
- 0.6.0 Fast Capture and 0.7.0 tray row + 🔍 preview pane: not seen in the app yet.
- Hover-to-magnify was considered; a pane was chosen as more reliable on desktop.
- Research notes: `~/Dev/snapcam/research/` (Mac↔iPhone APIs, Magnifier wrapper).

## User preferences

- Talk in Russian; code comments in English, ≤ ~20 tokens each.
- Until the phone stand arrives, the model shoots with `take_photo` only after the user
  says «снимай».
- Prefers one-click flows, no countdowns for their own shots; terse UI labels.
