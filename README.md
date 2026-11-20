# snap-cam

Claude Code mod for macOS: take a photo with your iPhone (Continuity Camera) or Desk
View and get it into the chat in one click.

## Install

```
/plugin marketplace add realdnchka/snap-cam
/plugin install snap-cam@snapcam --scope project
```

Needs macOS with Xcode Command Line Tools; the helper app is built on first use.

## Usage

Buttons above the prompt — `📷 iPhone`, `🗂 DeskView` — and `/snap [iphone|desk|list]`.
A shot opens a preview window with a frame showing the captured area: −/+ (or the
keys) set the zoom (1–3×, centred crop, remembered per camera in
`~/Library/Application Support/snap-cam/{desk,iphone}-zoom.txt`); Space, Enter or
«Снять» shoots, Esc cancels. The JPEG (long side ≤ 2400 px) goes to
`~/Pictures/ClaudeSnaps/` and is attached as a thumbnail above the prompt. On send,
the mod tells the model to open the photo with Read.

- `iphone` — Continuity Camera (iPhone as a wireless webcam), frames as macOS gives them.
- `desk` — Desk View: top-down desk view, straightened by macOS.
- `list` — cameras and what each lets an app control (focus, torch, flash).

The iPhone window also has a flash switch (off / on / auto), remembered in `flash.txt`.
The model gets a tool, `mcp__snap-cam__take_photo` (`camera`, `delay_seconds`, `flash`):
the same window opens, shoots by itself after a 1.5 s warm-up plus the delay, and the
image comes back in the tool result. Esc cancels.

The helper `helper/SnapCam.swift` is compiled on first use into
`~/Library/Application Support/snap-cam/SnapCam.app` (needs Xcode Command Line Tools).
It runs as its own app so macOS asks camera permission for "SnapCam" and lets it see
Continuity Camera devices (`NSCameraUseContinuityCameraDeviceType`).
