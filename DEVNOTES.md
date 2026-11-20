# snap-cam — developer notes (handover, 2026-11-21)

Claude Code mod + tiny macOS app. Lets the user (and the model) take a photo with the
iPhone (SnapCam iPhone app, else Continuity Camera) or Desk View and get it into the
session. Built 2026-11-16…19; iPhone app path 2026-11-21 (0.8.0).
Design decisions: `decisions/`. The iPhone/Mac apps live in `~/Dev/snapcam/snapcam-app`.

## Files

| Path | What |
|---|---|
| `.claude-plugin/plugin.json` | manifest; **bump `version` on every change** (now 0.8.0) |
| `hooks/hooks.json` → `hooks/register.tsx` | the mod (Claude Code function hooks API) |
| `types/index.d.ts` | `$.state` contract: `snap-cam.{busy, pending, viewing}` |
| `helper/SnapCam.swift` + `helper/Info.plist` | the Continuity/Desk View helper, built on first use |
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
- **iPhone app path** (`shoot` → `shootPhone`, iPhone mode only): `findCli` =
  `$SNAPCAM_CLI`, else `~/Applications/SnapCam.app/Contents/Helpers/snapcam-cli`, else
  `/Applications/…`. Runs `snapcam-cli capture --json --delay <s> --timeout 25
  --preview <ClaudeSnaps/iphone-stamp.jpg> --preview-size 2400 [--lens] [--zoom]
  [--flash]`; unset options (flash, format, size, rotation) use the Mac app's inspector
  settings for that phone, and `--lens`/`--zoom` replace the pair. The CLI talks to SnapCam for Mac over
  `~/Library/Application Support/SnapCam/control.sock`, launching the app if needed; the
  app owns pairing and the phone connection. `--preview` writes an upright JPEG (EXIF
  orientation applied, ImageIO). JSON: path, original, width/height (upright), format,
  lens, zoom, phone, ms, preview. Exit 0 → the preview is the snap; **69** (no app /
  not paired / phone app closed, decided before the shot is asked for) → Continuity
  helper with the reason in the tool text; 1 (phone error, or a timeout or drop after the
  shot was asked for: the phone may have shot) or other → `deny`. Band `📷 iPhone` uses
  it with a 3 s countdown to aim (the phone shows a live preview), Fast Capture with
  delay 0; busy = `phone` shows «снимает iPhone…». `/snap caps|status|pair` print the
  CLI's output; `pair` also brings up the Mac app's pairing sheet.
- **Continuity shot flow** (`shoot` → `runHelper`): `ensureApp` rebuilds SnapCam when
  `helper/SnapCam.swift` ≠ `built.swift` (swiftc + ad-hoc codesign), `pkill -f
  "<dir>/SnapCam.app/Contents/MacOS/SnapCam"` (by path: SnapCam for Mac has the same
  executable name), then `open -W -n SnapCam.app --args <mode> <out.jpg>
  <manual|delaySec> <status> [flash|""] [zoom]` (zoom 1–3 is one-shot, not saved).
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
  `flash`, `lens` ultraWide|wide|telephoto, `zoom` display 0.5–25): iPhone app path first,
  else the window with auto-shot after 1.5 s warm-up + delay (zoom → crop, lens ignored);
  returns `result: [{type:'text', <path + which path/lens/zoom/size>}, {type:'image'}]`.
- **`/snap iphone|desk|list|caps|status|pair`** — `list` prints every Continuity camera with
  focus/torch/flash support; `caps|status|pair` go to `snapcam-cli`.
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

- 0.8.0 iPhone app path: the CLI side was checked against the Simulator (capture with
  zoom + preview → 2400×1800 JPEG; exit 69 with the phone app closed); the mod itself not
  yet run in a session, and SnapCam for Mac is not yet installed in `~/Applications`.
- Fallback cost: with the app installed but no phone, an iPhone shot waits ~3–8 s
  (plus app launch) before Continuity opens.

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
