# snap-cam

Claude Code mod for macOS: take a photo with your iPhone or Desk View and get it into the
chat in one click. With the SnapCam iPhone app (repo `snapcam-app`, decision 0001) the phone
shoots at full resolution with real lenses and zoom; without it the mod uses Continuity
Camera.

## Install

```
/plugin marketplace add realdnchka/snap-cam
/plugin install snap-cam@snapcam --scope project
```

Needs macOS with Xcode Command Line Tools; the helper app is built on first use.

## iPhone app path

If SnapCam for Mac is installed (`scripts/install-mac.sh` in `snapcam-app` puts it in
`~/Applications`) and paired with SnapCam on the iPhone, iPhone shots go through its
command-line client `SnapCam.app/Contents/Helpers/snapcam-cli` (or `$SNAPCAM_CLI`):

- the phone shoots at once (its screen shows the framing); the original (HEIC, up to the
  phone's max size, e.g. 48 MP) stays in the SnapCam save folder (default
  `~/Pictures/SnapCam/Default`), an upright JPEG copy
  (long side ≤ 2400 px) goes to `~/Pictures/SnapCam/ClaudeSnaps/` for the chat;
- the SnapCam app must be open on the iPhone; the Mac app waits up to ~10 s for a paired
  phone that is reconnecting. When no paired phone answers (exit 69) or a paired one
  didn't reconnect in time (exit 75), the mod falls back to Continuity Camera as below
  and says why; if Continuity fails too, the error names both causes;
- `/snap caps` — what the phone's camera can do; `/snap status`; `/snap pair` — opens
  pairing on the Mac and prints the code.

## Usage

Buttons above the prompt — `📷 iPhone`, `🗂 DeskView` — and `/snap [iphone|desk|list]`.
A shot opens a preview window with a frame showing the captured area: −/+ (or the
keys) set the zoom (1–3×, centred crop, remembered per camera in
`~/Library/Application Support/snap-cam/{desk,iphone}-zoom.txt`); Space, Enter or
«Снять» shoots, Esc cancels. The JPEG (long side ≤ 2400 px) goes to
`~/Pictures/SnapCam/ClaudeSnaps/` and is attached as a thumbnail above the prompt. On send,
the mod tells the model to open the photo with Read.

- `iphone` — Continuity Camera (iPhone as a wireless webcam), frames as macOS gives them.
- `desk` — Desk View: top-down desk view, straightened by macOS.
- `list` — cameras and what each lets an app control (focus, torch, flash).

The iPhone window also has a flash switch (off / on / auto), remembered in `flash.txt`.
The model gets a tool, `mcp__snap-cam__take_photo` (`camera`, `delay_seconds`, `flash`,
`lens`, `zoom`). Through the iPhone app it shoots after the delay with the given lens
(`ultraWide`, `wide`, `telephoto`) and Camera-app zoom (0.5, 1, 2, 5…), clamped to what the
phone has. Through Continuity Camera the same window opens and shoots by itself after a
1.5 s warm-up plus the delay; `zoom` becomes a 1–3× crop for that shot and `lens` is
ignored. The image comes back in the tool result; the text says which path was used.

With the SnapCam iPhone app the model also gets:

- `peek` — one current viewfinder frame, not saved, to check the framing;
- `frame` (`lens`, `zoom`, `exposure` in EV) — move the live camera without shooting; no
  inputs reads it;
- `light` (`level` 0..1 of the maximum, absolute, 0 = off; the phone clamps) — the phone's steady light; same as `flash` `on`, which
  stays lit until turned off; refused while the phone is hot;
- `camera_state` — lenses, zoom range, sizes, flash, light and exposure ranges, the live
  framing (with light and exposure) and how many phone shots wait in the tray;
- `recent_photos` (`count`, default 1, at most 5) — the newest photos of the SnapCam
  history (the Mac app's save folder, default `~/Pictures/SnapCam/Default`), whatever took
  them, newest first, as images. It only reads: the tray keeps its photos;
- `read_text` (`path`, or `recent` newest N, default 1) — on-device OCR on the Mac (Vision,
  English and Russian) of saved photos: paragraphs in reading order with a rough place
  (`[top left]`…). Never runs on live or enhanced frames;
- `ask_photo` (`question`, default: summarize; `path` / `recent`) — the Mac's on-device
  Apple model answers from that OCR text only. Needs Apple Intelligence on; otherwise it
  fails with the reason. Nothing leaves the Mac.

## Phone inbox

Photos shot with the shutter in the SnapCam iPhone app go to the Mac app's history and to
its inbox, a hidden queue for this tray (the Mac app shows no inbox). While a
session is open the mod checks it every ~3 s (never starting the Mac app; while the app is
not running, ever less often, up to every 30 s) and shows new
ones as thumbnails above the prompt, beside your own shots. Sending a prompt attaches them
and takes them from the inbox, so each is used once; if the take fails they stay in the tray
for the next prompt. ✕ drops one from the tray but leaves it in the inbox. A prompt takes
the tray only when the session is also open on a surface that shows it (terminal, desktop,
IDE); in a session seen only from Claude mobile the tray waits.

The helper `helper/SnapCam.swift` is compiled on first use into
`~/Library/Application Support/snap-cam/SnapCam.app` (needs Xcode Command Line Tools).
It runs as its own app so macOS asks camera permission for "SnapCam" and lets it see
Continuity Camera devices (`NSCameraUseContinuityCameraDeviceType`).
