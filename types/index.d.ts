export type SnapMode = 'iphone' | 'desk'

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
