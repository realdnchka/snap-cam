import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { contract } from '../contract.ts'

type Spec = { name: string; inputSchema?: { properties?: Record<string, unknown> } }
type Cell = { status: string; detail?: string }

const mcp = contract.cells.mcp as Record<string, Cell>

// Each backticked span: a tool, then its inputs.
function spans(markdown: string): string[][] {
  return [...markdown.matchAll(/`([^`]+)`/g)].map(m => (m[1] ?? '').split(/[\s,]+/).filter(Boolean))
}

async function registeredTools($: Engine, on: On): Promise<Map<string, Spec>> {
  const tools = new Map<string, Spec>()
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => {
    const spec = e as unknown as Spec
    tools.set(spec.name, spec)

    return { value: { tool: `mcp__snap-cam__${spec.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  return tools
}

test('every MCP cell that works names registered tools and their inputs', async ($, on) => {
  const tools = await registeredTools($, on)
  const working = Object.entries(mcp).filter(([, cell]) => cell.status === 'available')
  expect(working.length).toBeGreaterThan(0)
  for (const [command, cell] of working) {
    for (const [tool = '', ...inputs] of spans(cell.detail ?? '')) {
      expect({ command, tool, ok: tools.has(tool) }).toEqual({ command, tool, ok: true })
      const properties = Object.keys(tools.get(tool)?.inputSchema?.properties ?? {})
      for (const input of inputs) {
        expect({ command, input, ok: properties.includes(input) }).toEqual({ command, input, ok: true })
      }
    }
  }
})

test('the contract names the camera tools of ADR 0003', () => {
  const detail = (command: string) => spans(mcp[command]?.detail ?? '')
  expect(detail('shoot')).toEqual([['take_photo']])
  expect(detail('frameLens')).toEqual([['frame', 'lens'], ['take_photo', 'lens']])
  expect(detail('frameZoom')).toEqual([['frame', 'zoom'], ['take_photo', 'zoom']])
  expect(detail('flash')).toEqual([['take_photo', 'flash']])
  expect(detail('light')).toEqual([['light', 'level']])
  expect(detail('exposure')).toEqual([['frame', 'exposure']])
  expect(detail('peek')).toEqual([['peek']])
  expect(detail('state')).toEqual([['camera_state']])
  expect(detail('inbox')).toEqual([])
  expect(mcp.inbox?.status).toBe('notApplicable')
  expect(detail('recent')).toEqual([['recent_photos', 'count']])
})

const CLI = '/cli/snapcam-cli'
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const item = (id: string) => ({ id, original: `/Pictures/SnapCam/Default/SnapCam ${id}.heic`, width: 4, height: 3 })

// A Mac app with photos A and B in the inbox; records every CLI call. The first `failTakes` takes fail.
function fakeMac(on: On, failTakes = 0): string[][] {
  const calls: string[][] = []
  let inbox = [item(A), item(B)]
  on('fs.exists', (_, e) => ({ value: e.path === CLI || e.path.includes('/ClaudeSnaps/') }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[0] !== CLI) return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    calls.push(argv.slice(1))
    if (argv[1] === 'recent') {
      const dir = argv[argv.indexOf('--preview-dir') + 1]
      const items = [
        { original: '/Pictures/SnapCam/Default/SnapCam 2026-11-21 at 10.00.02.heic', preview: `${dir}/SnapCam 2026-11-21 at 10.00.02.jpg`, width: 4, height: 3, origin: 'phone', queued: true },
        { original: '/Pictures/SnapCam/Default/SnapCam 2026-11-21 at 10.00.01.jpg', preview: `${dir}/SnapCam 2026-11-21 at 10.00.01.jpg`, width: 4, height: 3, origin: 'mac' },
      ]

      return { value: { exitCode: 0, stdout: JSON.stringify({ folder: '/Pictures/SnapCam/Default', items }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.includes('--take') && failTakes > 0) {
      failTakes -= 1

      return { value: { exitCode: 75, stdout: '', stderr: 'snapcam-cli: phone busy', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.includes('--take')) {
      const ids = argv.flatMap((arg, i) => (arg === '--id' ? [argv[i + 1]] : []))
      const count = Number(argv[argv.indexOf('--take') + 1]) || inbox.length
      const taken = ids.length > 0 ? inbox.filter(one => ids.includes(one.id)) : inbox.slice(0, count)
      inbox = inbox.filter(one => !taken.includes(one))
      const items = taken.map(one => ({ ...one, preview: `/staging/${one.id}.jpg` }))

      return { value: { exitCode: 0, stdout: JSON.stringify({ items, remaining: inbox.length }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    return { value: { exitCode: 0, stdout: JSON.stringify({ items: inbox, remaining: inbox.length }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return calls
}

test('phone shots reach the tray; a submit takes only the ones still there', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const clock = mock.clock(on)
  const calls = fakeMac(on)
  let sent = ''
  on('prompt.submit', (_, e) => {
    sent = e.text
    return { text: e.text, context: e.context }
  })
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as Spec).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3000)

  expect(calls[0]).toEqual(['inbox', '--json', '--no-launch'])
  expect(calls.every(args => args.includes('--no-launch'))).toBe(true)
  const ui = await $.ui.mount({
    plugin: 'snap-cam',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false },
  } as never)
  await ui.press({ key: `x:${B}` })
  await ui.unmount()

  await $.prompt.submit({ text: 'look', wait: false, origin: { kind: 'unclassified' } })

  const take = calls.find(args => args.includes('--take')) ?? []
  expect(take.filter(arg => arg === '--id')).toHaveLength(1)
  expect(take[take.indexOf('--id') + 1]).toBe(A)
  expect(sent).toContain(`📷 phone-aaaaaaaa.jpg`)
  expect(sent).not.toContain('phone-bbbbbbbb')
})

test('a failed take keeps phone shots in the tray and attaches none of them', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const clock = mock.clock(on)
  const calls = fakeMac(on, 1)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as Spec).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3000)

  await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'unclassified' } })
  expect(sent.at(-1)).toBe('first')

  await $.prompt.submit({ text: 'second', wait: false, origin: { kind: 'unclassified' } })
  expect(calls.filter(args => args.includes('--take'))).toHaveLength(2)
  expect(sent.at(-1)).toContain('📷 phone-aaaaaaaa.jpg')
  expect(sent.at(-1)).toContain('📷 phone-bbbbbbbb.jpg')
})

test('with no drawing surface the tray stays put and the model hears it waits', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const clock = mock.clock(on)
  const calls = fakeMac(on)
  let context: readonly string[] = []
  on('prompt.submit', (_, e) => {
    context = e.context ?? []
    return { text: e.text, context: e.context }
  })
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as Spec).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: [] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3000)

  await $.prompt.submit({ text: 'look', wait: false, origin: { kind: 'unclassified' } })

  expect(calls.some(args => args.includes('--take'))).toBe(false)
  expect(context.join('\n')).toContain('2 camera photo(s) wait in the SnapCam tray')
})

test('take_inbox is gone; recent_photos reads history and leaves the tray alone', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const clock = mock.clock(on)
  const calls = fakeMac(on)
  on('fs.read', () => ({ value: { base64: 'AA==' } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const tools = new Set<string>()
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => {
    const name = (e as unknown as Spec).name
    tools.add(name)
    return { value: { tool: `mcp__snap-cam__${name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3000)

  expect(tools.has('take_inbox')).toBe(false)
  expect(tools.has('recent_photos')).toBe(true)
  const done = (await $.tool.call({ tool: 'mcp__snap-cam__recent_photos', count: 40 } as never)) as unknown as {
    result?: { type: string; text?: string; source?: { type: string; media_type?: string } }[]
    deny?: string
  }

  const recent = calls.filter(args => args[0] === 'recent')
  expect(done.deny).toBeUndefined()
  expect(recent[0]?.slice(0, 2)).toEqual(['recent', '5'])
  expect(recent[0]).toContain('--preview-dir')
  expect(recent[0]).not.toContain('--no-launch')
  expect(calls.some(args => args.includes('--take'))).toBe(false)
  const blocks = done.result ?? []
  expect(blocks.map(block => block.type)).toEqual(['text', 'image', 'image'])
  expect(blocks[0]?.text).toContain('newest first')
  expect(blocks[0]?.text).toContain('/home/Pictures/SnapCam/ClaudeSnaps/recent-SnapCam-2026-11-21-at-10.00.02.jpg')
  expect(blocks[0]?.text).toContain('iPhone shutter')
  expect(blocks[1]?.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AA==' })

  // The tray still takes its phone shots on submit.
  await $.prompt.submit({ text: 'look', wait: false, origin: { kind: 'unclassified' } })
  expect(calls.some(args => args.includes('--take'))).toBe(true)
})

test('recent_photos asks for one photo by default', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  mock.clock(on)
  const recent: string[][] = []
  on('fs.exists', (_, e) => ({ value: e.path === CLI }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === CLI) recent.push(argv.slice(1))

    return { value: { exitCode: 0, stdout: JSON.stringify({ folder: '/f', items: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as Spec).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const done = (await $.tool.call({ tool: 'mcp__snap-cam__recent_photos' } as never)) as unknown as {
    result?: { type: string; text?: string }[]
  }

  expect(recent[0]?.slice(0, 2)).toEqual(['recent', '1'])
  expect(done.result?.[0]?.text).toContain('No photos')
})

test('take_photo shoots through the phone app and returns text plus the image', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  mock.clock(on)
  const captures: string[][] = []
  on('fs.exists', (_, e) => ({ value: e.path === CLI }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: 'AA==' } }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] !== CLI || argv[1] !== 'capture') return ok('')
    captures.push(argv.slice(1))
    const out = argv[argv.indexOf('--preview') + 1]

    return ok(JSON.stringify({ preview: out, original: '/o.heic', width: 4, height: 3, phone: 'iPhone', zoom: 2 }))
  })
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as Spec).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const done = (await $.tool.call({ tool: 'mcp__snap-cam__take_photo', zoom: 2, delay_seconds: 0 } as never)) as unknown as {
    result?: { type: string; text?: string; source?: { type: string } }[]
    deny?: string
  }

  expect(done.deny).toBeUndefined()
  expect(captures).toHaveLength(1)
  expect(captures[0]).toContain('--zoom')
  const blocks = done.result ?? []
  expect(blocks.map(block => block.type)).toEqual(['text', 'image'])
  expect(blocks[0]?.text).toContain('Photo saved: /home/Pictures/SnapCam/ClaudeSnaps/iphone-')
  expect(blocks[1]?.source?.type).toBe('base64')
})

// Records CLI calls; every call answers with one framing line.
function fakeFraming(on: On): string[][] {
  const calls: string[][] = []
  on('fs.exists', (_, e) => ({ value: e.path === CLI }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === CLI) calls.push(argv.slice(1))
    const stdout = 'iPhone: wide 1x, flash on, light 0.5, exposure -1 EV\n'

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as Spec).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return calls
}

type Done = { result?: { type: string; text?: string }[]; deny?: string }

test('light sets a level, 0 turns it off, out-of-range levels are clamped', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const calls = fakeFraming(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const lit = (await $.tool.call({ tool: 'mcp__snap-cam__light', level: 0.5 } as never)) as unknown as Done
  await $.tool.call({ tool: 'mcp__snap-cam__light', level: 0 } as never)
  await $.tool.call({ tool: 'mcp__snap-cam__light', level: 7 } as never)
  const bad = (await $.tool.call({ tool: 'mcp__snap-cam__light' } as never)) as unknown as Done

  expect(calls).toEqual([['light', '0.5'], ['light', 'off'], ['light', '1']])
  expect(lit.result?.[0]?.text).toContain('light 0.5')
  expect(bad.deny).toContain('level')
})

test('frame sets exposure alone or after lens and zoom', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const calls = fakeFraming(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const done = (await $.tool.call({ tool: 'mcp__snap-cam__frame', exposure: -1 } as never)) as unknown as Done
  await $.tool.call({ tool: 'mcp__snap-cam__frame', zoom: 2, exposure: 0.5 } as never)
  await $.tool.call({ tool: 'mcp__snap-cam__frame' } as never)

  expect(calls).toEqual([['exposure', '-1'], ['frame', '--zoom', '2'], ['exposure', '0.5'], ['frame']])
  expect(done.result?.[0]?.text).toContain('Framing set')
  expect(done.result?.[0]?.text).toContain('exposure -1 EV')
})

const ran = (exitCode: number, stdout = '', stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

function startHooks(on: On): void {
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__snap-cam__${(e as unknown as Spec).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('overlapping submits take a tray photo once', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const clock = mock.clock(on)
  const takes: string[][] = []
  let open: () => void = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  on('fs.exists', (_, e) => ({ value: e.path === CLI || e.path.includes('/ClaudeSnaps/') }))
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    if (argv[0] !== CLI) return ran(0)
    if (!argv.includes('--take')) return ran(0, JSON.stringify({ items: [item(A)], remaining: 1 }))
    takes.push(argv.slice(1))
    await gate

    return ran(0, JSON.stringify({ items: [{ ...item(A), preview: `/staging/${A}.jpg` }], remaining: 0 }))
  })
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('session.surfaces', () => ({ value: ['desktop'] }))
  startHooks(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3000)

  const first = $.prompt.submit({ text: 'one', wait: false, origin: { kind: 'unclassified' } })
  const second = $.prompt.submit({ text: 'two', wait: false, origin: { kind: 'unclassified' } })
  open()
  await Promise.all([first, second])

  expect(takes).toHaveLength(1)
  expect(sent.filter(text => text.includes('📷 phone-aaaaaaaa.jpg'))).toHaveLength(1)
})

test('a submit from a mobile-only session leaves the tray', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const clock = mock.clock(on)
  const calls = fakeMac(on)
  let sent = ''
  on('prompt.submit', (_, e) => {
    sent = e.text
    return { text: e.text, context: e.context }
  })
  on('session.surfaces', () => ({ value: ['mobile'] }))
  startHooks(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  await clock.advance(3000)

  await $.prompt.submit({ text: 'from the phone', wait: false, origin: { kind: 'bridge' } })

  expect(calls.some(args => args.includes('--take'))).toBe(false)
  expect(sent).toBe('from the phone')
})

test('recent_photos keeps same-named photos apart, lists unreadable ones, cleans staging', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  mock.clock(on)
  const runs: string[][] = []
  on('fs.exists', (_, e) => ({ value: e.path === CLI || e.path.includes('/ClaudeSnaps/') }))
  on('fs.read', () => ({ value: { base64: 'AA==' } }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv[0] !== CLI) return ran(0)
    const dir = argv[argv.indexOf('--preview-dir') + 1]
    const items = [
      { original: '/D/IMG 1.heic', preview: `${dir}/IMG 1.jpg`, width: 4, height: 3 },
      { original: '/D/IMG 1.jpg', preview: `${dir}/IMG 1 2.jpg`, width: 4, height: 3 },
      { original: '/D/broken.heic', error: "Can't decode broken.heic" },
    ]

    return ran(0, JSON.stringify({ folder: '/D', items }), "snapcam-cli: no preview for /D/broken.heic\n")
  })
  startHooks(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const done = (await $.tool.call({ tool: 'mcp__snap-cam__recent_photos', count: 3 } as never)) as unknown as Done & {
    result?: { type: string }[]
  }

  const text = done.result?.[0]?.text ?? ''
  expect(done.deny).toBeUndefined()
  expect(done.result?.map(block => block.type)).toEqual(['text', 'image', 'image'])
  expect(text).toContain('/home/Pictures/SnapCam/ClaudeSnaps/recent-IMG-1.jpg')
  expect(text).toContain('/home/Pictures/SnapCam/ClaudeSnaps/recent-IMG-1-2.jpg')
  expect(text).toContain("/D/broken.heic: Can't decode broken.heic")
  const recent = runs.find(argv => argv[0] === CLI) ?? []
  const staging = recent[recent.indexOf('--preview-dir') + 1] ?? ''
  expect(staging.startsWith('/home/Library/Application Support/snap-cam/recent-staging/')).toBe(true)
  expect(runs.at(-1)).toEqual(['rm', '-rf', staging])
})

test('inbox polls back off while the Mac app is down and reset on a submit', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const clock = mock.clock(on)
  let up = false
  const polls: number[] = []
  let now = 0
  on('fs.exists', (_, e) => ({ value: e.path === CLI }))
  on('process.run', (_, e) => {
    if (e.argv[0] !== CLI) return ran(0)
    polls.push(now)

    return up ? ran(0, JSON.stringify({ items: [], remaining: 0 })) : ran(69, '', 'snapcam-cli: SnapCam is not running')
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  startHooks(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const tick = async (seconds: number) => {
    for (let s = 0; s < seconds; s += 3) {
      now += 3
      await clock.advance(3000)
    }
  }

  await tick(102)
  // The first poll is the one session.start fires.
  expect(polls.slice(1)).toEqual([6, 18, 42, 72, 102])

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'unclassified' } })
  await tick(3)
  expect(polls.at(-1)).toBe(105)

  up = true
  await tick(6)
  await tick(9)
  expect(polls.slice(-3)).toEqual([114, 117, 120])
})

test('frame treats a null exposure as unset', async ($, on) => {
  mock.env(on, { HOME: '/home', SNAPCAM_CLI: CLI })
  const calls = fakeFraming(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  await $.tool.call({ tool: 'mcp__snap-cam__frame', zoom: 2, exposure: null } as never)
  await $.tool.call({ tool: 'mcp__snap-cam__frame', exposure: null } as never)

  expect(calls).toEqual([['frame', '--zoom', '2'], ['frame']])
})
