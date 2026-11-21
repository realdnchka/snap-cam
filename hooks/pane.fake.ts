import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

export const CLI = '/cli/snapcam-cli'
export const HOME = '/Users/me'
export const LIVE = `${HOME}/Library/Application Support/snap-cam/live`
export const A = 'aaaaaaaa-0000-4000-8000-000000000001'
export const ORIGINAL = '/Pictures/SnapCam/Default/SnapCam 2026-11-22 at 10.00.01.heic'
export const RECENT = 'recent-SnapCam-2026-11-22-at-10.00.01.jpg'

const STATE = {
  appVersion: '1',
  phone: 'iPhone',
  caps: {
    lenses: [
      { kind: 'ultraWide', displayZoom: 0.5 },
      { kind: 'wide', displayZoom: 1 },
      { kind: 'telephoto', displayZoom: 5 },
    ],
    zoom: { min: 0.5, max: 25 },
    flashModes: ['off', 'on', 'auto'],
    hasTorch: true,
    maxLightLevel: 1,
    exposure: { min: -2, max: 2 },
  },
  framing: { lens: 'wide', zoom: 1, flash: 'off', light: 0, exposure: 0, lightAvailable: true },
  inbox: 1,
  sources: [
    { id: 'phone', kind: 'phone', name: 'iPhone', selected: true },
    { id: 'x', kind: 'deskView', name: 'Desk View', selected: false },
  ],
}

export type Fake = { calls: string[][]; runs: string[][]; spawns: string[][]; stopped: number; blits: unknown[] }

export type FakeOptions = {
  surfaces?: () => RenderSurface[]
  // A snapcam-cli without `live`, exiting 64 at once.
  oldCli?: boolean
  // A line the stream sends after its frames.
  tail?: object
  // Lens and zoom the stream reports, as if moved on the phone.
  live?: { lens: string; zoom: number }
}

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// A Mac app for the pane: state, recent, inbox, framing commands, and `live` frames.
export function fakePaneMac(on: On, shown: () => boolean, options: FakeOptions = {}): Fake {
  const { oldCli = false, tail, live = { lens: 'wide', zoom: 1 } } = options
  const surfaces = options.surfaces ?? (() => ['desktop'])
  const fake: Fake = { calls: [], runs: [], spawns: [], stopped: 0, blits: [] }
  mock.env(on, { HOME, SNAPCAM_CLI: CLI })
  on('fs.exists', (_, e) => ({ value: e.path === CLI || e.path.startsWith(LIVE) || e.path.includes('/ClaudeSnaps/') || e.path.includes('/thumbs/') }))
  on('fs.read', () => ({ value: { base64: 'AA==' } }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    fake.runs.push(argv)
    if (argv[0] !== CLI) return ok('')
    fake.calls.push(argv.slice(1))
    const framing = (patch: object) => ok(JSON.stringify({ phone: 'iPhone', framing: { ...STATE.framing, ...patch } }))
    switch (argv[1]) {
      case 'state': return ok(JSON.stringify(STATE))
      case 'recent': return ok(JSON.stringify({ folder: '/Pictures/SnapCam/Default', items: [{ original: ORIGINAL }] }))
      case 'inbox': return ok(JSON.stringify({ items: [{ id: A, original: '/Pictures/SnapCam/Default/a.heic' }], remaining: 1 }))
      case 'frame': return framing(argv.includes('--lens') ? { lens: argv[argv.indexOf('--lens') + 1] } : { zoom: Number(argv[argv.indexOf('--zoom') + 1]) })
      case 'flash': return framing({ flash: argv[2] })
      case 'light': return framing({ light: argv[2] === 'off' ? 0 : Number(argv[2]) })
      case 'exposure': return framing({ exposure: Number(argv[2]) })
      case 'capture': {
        const out = argv[argv.indexOf('--preview') + 1]
        return ok(JSON.stringify({ preview: out, original: '/o.heic', width: 4, height: 3, phone: 'iPhone' }))
      }
      default: return ok('')
    }
  })
  on('process.spawn', async function* (_, e, next) {
    fake.spawns.push([...e.argv].slice(1))
    if (oldCli) {
      yield { stream: 'stderr' as const, text: 'snapcam-cli: missing or unknown command\n' }
      return { value: { code: 64, signal: null } }
    }
    const png = e.argv.includes('--png') ? `${LIVE}/live.png` : undefined
    try {
      for (let seq = 1; seq <= 2; seq += 1) {
        yield { stream: 'stdout' as const, text: JSON.stringify({ seq, preview: `${LIVE}/live.jpg`, png, width: 640, height: 480, lens: live.lens, zoom: live.zoom, phone: 'iPhone', ms: 9 }) + '\n' }
      }
      if (tail) yield { stream: 'stdout' as const, text: JSON.stringify(tail) + '\n' }
      // Stays open like the real CLI until the mod ends the loop.
      await new Promise<void>(done => next.signal.addEventListener('abort', () => done()))
    } finally {
      fake.stopped += 1
    }

    return { value: { code: 0, signal: null } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: shown() ? [{ id: 'snap-live', title: 'SnapCam', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.blit', (_, e) => {
    fake.blits.push(e)
    return { value: {} }
  })
  on('session.surfaces', () => ({ value: surfaces() }))
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return fake
}

const PANE = {
  plugin: 'snap-cam',
  component: 'Pane',
  requestId: 'snap-live',
  props: { title: 'SnapCam', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

export async function openPane($: Engine, surface: 'desktop' | 'terminal' = 'desktop') {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  await $.command.run({ command: 'snap', args: 'pane' } as never)

  return $.ui.mount({ ...PANE, surface } as never)
}

