# snap-cam — developer notes (handover, 2026-11-21)

Claude Code mod. Lets the user (and the model) take a photo with the SnapCam iPhone app,
Continuity Camera, Desk View or the Mac's camera — all through SnapCam for Mac's
`snapcam-cli` — and get it into the session. Built 2026-11-16…19; iPhone app path
2026-11-21 (0.8.0); the own Continuity/Desk View helper was removed in 0.9.0 (ADR 0004).
Design decisions: `decisions/`. The iPhone/Mac apps live in `~/Dev/snapcam/snapcam-app`.

## Files

| Path | What |
|---|---|
| `.claude-plugin/plugin.json` | manifest; **bump `version` on every change** (now 0.9.0) |
| `hooks/hooks.json` → `hooks/register.tsx` | the mod (Claude Code function hooks API) |
| `types/index.d.ts` | `$.state` contract: `snap-cam.{busy, pending, viewing, phoneTray, dismissed}` |
| `README.md` | user-facing summary |
| `contract.ts` + `hooks/contract.test.ts` | generated camera contract (ADR 0003); `claude plugin test .` checks every ✅ MCP cell names registered tools and inputs, plus the inbox tray and `recent_photos` against a fake CLI |

Runtime state (outside the repo): `~/Library/Application Support/snap-cam/`
— `last-mode.txt` (camera of the last band shot, for Fast Capture), `thumbs/`, `previews/` (+ `.json` size sidecar),
`inbox-staging/` (CLI inbox previews before the move), `recent-staging/<stamp>-<n>/` (one per
`recent_photos` call, removed after it), `peek.jpg` (last `peek`, overwritten).
Photos: `~/Pictures/SnapCam/ClaudeSnaps/<mode>-<YYYYMMDD-HHMMSS>.jpg`. Leftovers of the
pre-0.9 helper (`SnapCam.app`, `built.swift`, `mc/`, `*.txt`, `debug.log`) are unused.

## How it works

- **Band above the prompt** (`ui.render AbovePrompt`, desktop/terminal/vscode, not mobile):
  row 1 = tray of pending thumbnails (🔍 opens the preview pane, ✕ drops it); row 2 =
  `📷 iPhone`, `🗂 DeskView`, `⚡ Fast Capture` (last-used camera, auto-shot, delay 0).
- **One capture path** (0.9.0, ADR 0004; `shoot`): `findCli` = `$SNAPCAM_CLI`, else
  `~/Applications/SnapCam.app/Contents/Helpers/snapcam-cli`, else `/Applications/…`; none →
  the tool fails with «build it from snapcam-app with scripts/install-mac.sh». Runs
  `snapcam-cli capture [--source <src>] --json --delay <s> --timeout 25|55 --preview
  <ClaudeSnaps/<mode>-stamp.jpg> --preview-size 2400 [--lens] [--zoom] [--flash]`.
  `SOURCES` maps `camera` → `--source`: `iphone` → `phone`, `continuity`, `desk` →
  `deskView`, `mac` → `builtIn`; `--source` and `--lens` only as needed (no `--source` for
  the phone, so an older Mac app still shoots with it); 55 s timeout for Mac cameras (the app
  waits up to 25 s for Continuity/Desk View to appear). Unset options (flash, format,
  size, rotation, Mac zoom) use the Mac app's settings for that camera; `--lens`/`--zoom`
  replace the pair. The CLI talks to SnapCam for Mac over
  `~/Library/Application Support/SnapCam/control.sock`, launching the app if needed; the app
  owns pairing, the phone connection and the Mac cameras (`Mac/MacCamera.swift`,
  `Mac/MacCameras.swift` in snapcam-app). `--preview` writes an upright JPEG. JSON: path,
  original, width/height (upright), format, lens, zoom, phone (the camera's name for Mac
  sources), ms, preview. Any non-zero exit → `deny` with `cliFailure` (69 app/phone/camera
  not reachable, 75 paired phone didn't connect, 64 usage — likely an older app, 1 camera
  error). No fallback: exit 69 for the phone no longer opens Continuity. Band `📷 iPhone` /
  `🗂 DeskView` and Fast Capture shoot at once; busy shows «снимает <camera>…».
  `/snap caps|status|pair` print the CLI's output; `/snap list` prints `state`.
- **Phone inbox in the tray** (0.8.8, ADR 0003 step 3; snapcam-app `feat/inbox`): photos shot
  with the iPhone app's own shutter land in the Mac app's inbox. In interactive sessions
  `session.start` starts `$.clock.every(3000)` → `pollTick` → `pollInbox`: when `findCli` finds the CLI,
  `snapcam-cli inbox --json --no-launch` (never launches the app; exit 69 or bad JSON leaves
  the tray as is; one poll at a time). Backoff (0.8.11): after n exit-69 polls in a row the
  next one waits min(2ⁿ, 10) ticks (6, 12, 24, 30 s…); exit 0 or a prompt submit resets it. Listed items minus `dismissed` become `phoneTray`
  (`{id, original, name}`, name `phone-<first 8 of id>.jpg`, chat-safe: originals are
  `SnapCam 2026-… at ….heic`); thumbs are made with sips from the original. `dismissed`
  is pruned to ids still listed. The tray draws them beside band shots; 🔍 previews the
  original; ✕ adds the id to `dismissed` (the photo stays in the inbox, other sessions
  still see it). On prompt submit, tray photos not already in `taking` (module set of ids a
  submit is taking; filled in the same tick as the tray read, cleared in `finally`) are taken with `inbox --take --id … --preview-dir
  inbox-staging --preview-size 2400 --json --no-launch` and moved to
  `ClaudeSnaps/phone-….jpg` (upright, EXIF applied by the app); ids the app no longer has
  (taken elsewhere) or a failed take (app quit; toast) fall back to a sips JPEG of the
  original, so what the user saw is still attached, consumed once per session.
  Surface rule (0.8.11): a prompt takes the tray (band shots and phone photos) only when
  `$.session.surfaces()` holds a surface that draws it (anything but `mobile`). The
  submit doesn't say which surface sent it, so with desktop and mobile both attached a
  mobile prompt still takes the tray the desktop shows; mobile-only leaves it untouched.
  Band shots are taken out of `pending` inside one `update`, so two submits can't share them.
- **Camera tools for the model** (0.8.9), all via `snapcam-cli` (may launch the app):
  `peek` (`peek --preview peek.jpg --json`, ~1280 px raw frame, not in the photo library;
  text + image), `frame(lens?, zoom?, exposure?)` (`frame [--lens] [--zoom]`, then
  `exposure EV` when given; exposure alone skips `frame`; text; no inputs reads),
  `light(level)` (0.8.10; `light LEVEL|off`, absolute level clamped 0..1, 0 = off; text),
  `frame` ignores `exposure: null` (0.8.11; it used to become 0 EV),
  `peek(camera?)` (0.9.0) passes `--source` like `take_photo`; `frame`/`light` drive the phone only,
  `camera_state` (`state`, text: sources (0.9.0; `*` = chosen in the Mac app), caps incl. light/exposure ranges, live framing incl.
  light/exposure/`light off (hot)`, inbox count; exit 0 without a phone),
  `recent_photos(count?)` (0.8.9, replaces `take_inbox`; `recent N --preview-dir
  recent-staging/<stamp>-<n> --preview-size 2400 --json`, default 1, cap 5): the newest photos of the Mac
  app's save folder, any origin (phone shutter, Mac, CLI), previews moved to
  `ClaudeSnaps/recent-<CLI staged name, chat-safe>.jpg` (the CLI makes names unique per call,
  `name 2.jpg`; the mod adds `-2` if chat-safe names still clash); items with `error`
  (CLI from snapcam-app `fix/sprint-1`) are listed as unreadable, the rest still come; text with paths, origin (from the
  app's `com.realdnchka.snapcam.origin` xattr; unknown for older files) and «also in the
  tray» + one image block each. Reads only: the inbox and the tray are untouched; the
  hidden inbox queue now exists only for the tray. Failures `deny` with the exit-code reason (69/75/64/1). Descriptions say: look
  (peek), adjust (frame), then shoot, and shoot only when the user allows.
- **Tray → prompt**: `prompt.submit` appends `📷 <name>` lines to the text and a
  `context` note telling the model to `Read` the paths; `ui.render UserMessage` hides those
  lines and draws thumbnails + 🔍 instead.
- **Preview pane**: `openPreview` makes `previews/<name>` (sips, ≤800 px, shrinks until
  < 90 KB so the inline SVG stays under the 131 072-char `Svg.source` limit) + size json,
  sets `viewing`, `$.ui.open({ id: 'snap-preview' })`; `ui.render Pane` draws it.
- **Model tool** `mcp__snap-cam__take_photo` (`camera` iphone|continuity|desk|mac,
  `delay_seconds` 0–60, default 3, `flash` (on = the steady light on the phone; a real flash
  on Mac cameras that have one), `lens` ultraWide|wide|telephoto (phone only), `zoom` display
  0.5–25, Mac cameras clamp to a 1–3× crop); returns `result: [{type:'text', <path + camera,
  lens/zoom, size>}, {type:'image'}]`.
- **`/snap iphone|continuity|desk|mac|list|caps|status|pair`**.

## Facts established on this Mac (MacBook Pro + iPhone)

Found with the old helper (removed in 0.9.0); SnapCam for Mac's `MacCamera` builds on them:
crop zoom, largest photo format with 1080p accepted, frames as delivered (no rotation),
Desk View from video frames, the Continuity black-frame check.

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
- **Sidecar blocks Continuity Camera** (2026-11-21 incident): with an iPad as a Sidecar
  display, `wifip2pd` refuses the RemoteCamera Wi‑Fi reservation ("<Mac> is currently
  using Sidecar"), ContinuityCaptureAgent leaves the device Disabled and feeds a black
  placeholder buffer. AVFoundation reports nothing: input, session start and preview all
  "work"; only `capturePhoto` fails with `NSOSStatusErrorDomain 2` ("The operation could
  not be completed"). The reason never reaches public API. The helper therefore samples
  frames (8×8 grid, BGRA, max channel ≤ 6 = black): a Continuity device with ≥ 20 frames
  and none with light fails at the shot, and a capture error after only black frames,
  both with «Continuity Camera не запустилась: … обычно мешает Sidecar … или режим
  модема». A truly dark scene (lens covered) can trigger the same message.

## Mod API gotchas hit

- `tool.call` hook: the model's arguments are **on `e` itself** (beside `tool`), not
  `e.input`. Result must be a string or an array of blocks (not `{content}`).
- Tool-result images must use the Messages API shape `{type:'image', source:{type:'base64', media_type, data}}`;
  the MCP shape (`data`, `mimeType`) is dropped before the model (checked 0.8.4).
  An MCP-shape block reaches the API malformed: "Image couldn't be processed", and the session then drops
  every later image. Test image results only in a fresh session.
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

After a contract change in snapcam-app (`SnapCamKit/Contract.swift`), run its
`scripts/sync-contract.sh` (outside the sandbox; default target `~/Dev/snapcam/snap-cam`): it
rewrites `contract.ts` and the ADR 0003 block, then checks both with the opt-in SnapCamKit
test (`SNAPCAM_MOD=<this repo> swift test --filter modCopiesMatchTheRenderer`). Then
`claude plugin test ~/Dev/snapcam/snap-cam`.


## Open / unverified

- 0.9.0 (branches `feat/mac-sources` here and in snapcam-app): helper and Continuity fallback
  removed; every camera via `capture --source`. Checked with `claude plugin test` (fake CLI)
  and the app's unit tests; Mac cameras not yet run on the real Mac (Continuity, Desk View,
  built-in, flash, black-frame message). Needs the snapcam-app build with `--source`: an older
  CLI answers 64 («unknown option --source»).

- 0.8.11 (branch `fix/sprint-1`): overlapping-submit guard, mobile-only tray rule, poll
  backoff, `recent_photos` naming/errors/staging cleanup, `frame exposure: null`. Checked
  with `claude plugin test` (fake CLI) only. The real CLI's `recent --json` shape was checked
  against the installed app. snapcam-app `fix/sprint-1` raises the protocol to 6 and adds
  `light off (iPhone app in background)` to `state`/`frame` text; the mod passes it through.

- 0.8.10 `light` and `frame exposure`: checked with `claude plugin test` (fake CLI) only.
  Needs the snapcam-app `feat/camera-control` build (protocol 5, CLI `light`/`exposure`);
  an older app answers 64 (unknown command), an older phone a clear "update SnapCam" error.
  `take_photo flash on` now means the steady light (app-side change).

- 0.8.9 `recent_photos`: checked with `claude plugin test` (fake CLI) only. Needs the
  snapcam-app `feat/recent` build installed (CLI `recent`); an older app answers it with an
  error. Origins exist only for photos saved by that build.

- 0.8.8 inbox tray and camera tools: checked only with `claude plugin test` (fake CLI) and the
  real CLI's `--no-launch` exit 69; not run in a session nor against a phone. Needs the
  snapcam-app `feat/inbox` build installed (CLI with `--id`). `take_photo` text unchanged
  apart from the shoot-only-when-allowed sentence.

- 0.8.3: exit 75 path and the helper's black-frame check not yet run on the device;
  helper compiled with the mod's `swiftc` command only.
- 0.8.0 iPhone app path: the CLI side was checked against the Simulator (capture with
  zoom + preview → 2400×1800 JPEG; exit 69 with the phone app closed); the mod itself not
  yet run in a session, and SnapCam for Mac is not yet installed in `~/Applications`.
- Fallback cost: with the app installed but no phone, an iPhone shot waits ~3–8 s
  (plus app launch) before Continuity opens.

- 0.6.0 Fast Capture and 0.7.0 tray row + 🔍 preview pane: not seen in the app yet.
- Hover-to-magnify was considered; a pane was chosen as more reliable on desktop.
- Research notes: `~/Dev/snapcam/research/` (Mac↔iPhone APIs, Magnifier wrapper).

## User preferences

- Talk in Russian; code comments in English, ≤ ~20 tokens each.
- Until the phone stand arrives, the model shoots with `take_photo` only after the user
  says «снимай».
- Prefers one-click flows, no countdowns for their own shots; terse UI labels.
