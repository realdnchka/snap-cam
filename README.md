# snap-cam

Claude Code mod for macOS: take a photo with your iPhone, Desk View or a Mac camera and get
it into the chat in one click. Every shot goes through SnapCam for Mac (repo `snapcam-app`,
decisions 0001 and 0004): the SnapCam iPhone app shoots at full resolution with real lenses
and zoom; Continuity Camera, Desk View and the Mac's built-in camera are plain photos.

## Install

```
/plugin marketplace add realdnchka/snap-cam
/plugin install snap-cam@snapcam --scope project
```

The mod needs SnapCam for Mac: build and install it from `snapcam-app` with
`scripts/install-mac.sh` (puts it in `~/Applications`). Without it the camera tools say so.
The mod talks to the app's command-line client `SnapCam.app/Contents/Helpers/snapcam-cli`
(or `$SNAPCAM_CLI`).

## Cameras

| `camera` | Source (`snapcam-cli --source`) | What you get |
|---|---|---|
| `iphone` (default) | `phone` — SnapCam app on a paired iPhone | full resolution, lenses, zoom, light, exposure |
| `continuity` | `continuity` — the iPhone as Continuity Camera | plain photo, ≤ 1920×1440, crop zoom 1–3×, flash |
| `desk` | `deskView` — Desk View, top-down, straightened by macOS | video frame, crop zoom 1–3× |
| `mac` | `builtIn` — the Mac's own camera | plain photo, crop zoom 1–3× |

The original stays in the SnapCam save folder (default `~/Pictures/SnapCam/Default`); an
upright JPEG copy (long side ≤ 2400 px) goes to `~/Pictures/SnapCam/ClaudeSnaps/` for the chat.
For the iPhone app the SnapCam app must be open on the phone; the Mac app waits up to ~10 s
for a paired phone that is reconnecting. A wireless iPhone can take 10–20 s to appear as a
Continuity camera or Desk View; the Mac app waits up to 25 s for it.

The Mac app's window has the same sources in its toolbar camera picker; its Live pane shows
the chosen one (the iPhone's stream, or a Mac camera's preview with the crop frame), and
the inspector holds zoom and flash for Mac cameras. Settings per camera (zoom, flash, format) are used when the mod
leaves them unset.

## Usage

Buttons above the prompt — `📷 iPhone`, `🗂 DeskView`, `⚡ Fast Capture` (last camera, no
delay) — and `/snap [iphone|continuity|desk|mac]` shoot at once and attach the photo as a
thumbnail above the prompt. On send, the mod tells the model to open the photo with Read.

- `/snap pane` or `🎥 Панель` — the SnapCam pane beside the chat. Tab «Камера»: live video
  (~5 fps, raw frames of the iPhone stream or a Mac camera; Svg on the desktop; in a terminal
  an Image the frames blit into: kitty/Ghostty read the PNG file, iTerm2 3.5+ gets its bytes;
  elsewhere the pane shows text), `📸 Снять` (to the tray), camera switch (iPhone, Mac
  cameras and every external camera by name), and for the iPhone lens, zoom −/+, flash, light
  and exposure. Tab «Галерея»: phone photos in the inbox and the last 8 photos of the save
  folder; a press attaches one to the next message (✓), again detaches it. `📝 Текст` reads
  the text, `✨ Спросить` (or a question + Enter) asks the Mac's model, both on the newest
  attached photo or the last shot. Video runs only while the pane shows the camera tab;
- `/snap list` — the sources SnapCam for Mac sees (`snapcam-cli state`);
- `/snap caps` — what the phone's camera can do; `/snap status`; `/snap pair` — opens
  pairing on the Mac and prints the code.

The model gets:

- `take_photo` (`camera`, `delay_seconds`, `flash`, `lens`, `zoom`) — shoots after the delay.
  The iPhone app uses the lens (`ultraWide`, `wide`, `telephoto`) and Camera-app zoom (0.5,
  1, 2, 5…), clamped to what the phone has; Mac cameras crop 1–3× and ignore `lens`. The
  image comes back in the tool result; the text says which camera was used;
- `peek` (`camera`) — one current viewfinder frame, not saved, to check the framing;
- `frame` (`lens`, `zoom`, `exposure` in EV) — move the iPhone app's live camera without
  shooting; no inputs reads it;
- `light` (`level` 0..1 of the maximum, absolute, 0 = off; the phone clamps) — the phone's
  steady light; same as `flash` `on`, which stays lit until turned off; refused while hot;
- `camera_state` — the sources, then lenses, zoom range, sizes, flash, light and exposure
  ranges, the live framing and how many phone shots wait in the tray;
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

## License

MIT, see [LICENSE](LICENSE).
