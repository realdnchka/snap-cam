export type SnapMode = 'iphone' | 'desk'

declare module 'claude-code' {
  interface PluginState {
    'snap-cam': { busy: string; pending: string[]; viewing: string }
  }
}
