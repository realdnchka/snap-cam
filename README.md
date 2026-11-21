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
  phone's max size, e.g. 48 MP) stays in `~/Pictures/SnapCam/Default`, an upright JPEG copy
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

The helper `helper/SnapCam.swift` is compiled on first use into
`~/Library/Application Support/snap-cam/SnapCam.app` (needs Xcode Command Line Tools).
It runs as its own app so macOS asks camera permission for "SnapCam" and lets it see
Continuity Camera devices (`NSCameraUseContinuityCameraDeviceType`).
