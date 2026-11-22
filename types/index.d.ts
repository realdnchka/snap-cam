// take_photo cameras, plus external in the pane; the band shows iphone and desk.
export type SnapMode = 'iphone' | 'continuity' | 'desk' | 'mac' | 'external'

// A phone-shutter photo waiting in the Mac inbox, shown in the tray.
export type InboxItem = { id: string; original: string; name: string }

// The newest frame of the pane's live video; files from `snapcam-cli live`.
export type LiveFrame = {
  seq: number
  preview?: string
  png?: string
  width?: number
  height?: number
  lens?: string
  zoom?: number
  phone?: string
  error?: string
}

// Live framing of the phone, as `state`/`frame --json` report it.
export type Framing = { lens?: string; zoom: number; flash: string; light: number; exposure: number; lightAvailable?: boolean }

// What the pane's controls offer, from `snapcam-cli state --json`.
export type CameraInfo = {
  phone?: string
  lenses: { kind: string; zoom: number }[]
  zoomMin: number
  zoomMax: number
  flashModes: string[]
  hasLight: boolean
  exposureMin?: number
  exposureMax?: number
  framing?: Framing
  // `id` only for external cameras, one entry each.
  sources: { mode: SnapMode; name: string; id?: string }[]
}

// A photo of the save folder in the pane's gallery.
export type RecentItem = { original: string; name: string }

export type PaneTab = 'camera' | 'gallery'

declare module 'claude-code' {
  interface PluginState {
    'snap-cam': {
      busy: string
      pending: string[]
      viewing: string
      phoneTray: InboxItem[]
      dismissed: string[]
      inbox: InboxItem[]
      paneTab: PaneTab
      paneCamera: SnapMode
      paneSource: string
      liveFrame: LiveFrame
      cameraInfo: CameraInfo | null
      gallery: RecentItem[]
      paneNote: string
      paneText: string
      // Attached shot preview path → its original.
      shotOriginals: Record<string, string>
    }
  }
}
