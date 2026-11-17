export type SessionMode = 'none' | 'on' | 'off-scheduled' | 'off-manual'
export type Session = {
  mode: SessionMode
  onSince: number | null
  lastRequestAt: number | null
  pingedFor: number | null
}

declare module 'claude-code' {
  interface PluginState {
    keepalive: { session: Shaped<Session>; workingSince: number | null; line: string | null }
  }
}
