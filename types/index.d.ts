// take_photo cameras; the band shows iphone and desk.
export type SnapMode = 'iphone' | 'continuity' | 'desk' | 'mac'

// A phone-shutter photo waiting in the Mac inbox, shown in the tray.
export type InboxItem = { id: string; original: string; name: string }

declare module 'claude-code' {
  interface PluginState {
    'snap-cam': {
      busy: string
      pending: string[]
      viewing: string
      phoneTray: InboxItem[]
      dismissed: string[]
    }
  }
}
