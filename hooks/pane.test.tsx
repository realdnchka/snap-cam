import { expect, mock, test } from 'claude-code/testing'

import { A, HOME, LIVE, ORIGINAL, RECENT, fakePaneMac as fakeMac, openPane } from './pane.fake.ts'
import type { Fake } from './pane.fake.ts'
import { closeLive } from './live.tsx'

test('the pane streams live frames while its camera tab shows, and stops when hidden', async ($, on) => {
  let shown = true
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => shown)
  const ui = await openPane($)
  await clock.advance(1000)

  expect(fake.calls.some(args => args[0] === 'state')).toBe(true)
  expect(fake.spawns).toHaveLength(1)
  const [command, flag, dir, ...rest] = fake.spawns[0] ?? []
  expect([command, flag]).toEqual(['live', '--preview-dir'])
  expect(dir).toMatch(new RegExp(`^${LIVE}/[0-9a-f]{8}$`))
  expect(rest).toEqual(['--preview-size', '640', '--fps', '5', '--json'])
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect((await ui.find({ key: 'status' }))?.text).toContain('iPhone')

  shown = false
  await clock.advance(1000)
  expect(fake.stopped).toBe(1)
  await clock.advance(3000)
  expect(fake.spawns).toHaveLength(1)
  await ui.unmount()
})

test('the gallery tab pauses the video and lists recent photos and the inbox', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  const ui = await openPane($)
  await clock.advance(3000)
  expect(fake.spawns).toHaveLength(1)

  await ui.press({ key: 'tab:gallery' })
  expect(fake.stopped).toBe(1)
  expect(fake.calls.find(args => args[0] === 'recent')).toEqual(['recent', '8', '--json', '--no-launch'])
  expect(await ui.find({ key: `recent:${RECENT}` })).toBeDefined()
  expect(await ui.find({ key: `inbox:${A}` })).toBeDefined()
  await clock.advance(3000)
  expect(fake.spawns).toHaveLength(1)
  await ui.unmount()
})

test('a recent photo pressed in the gallery goes to the tray; pressed again it leaves', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  let sent = ''
  on('prompt.submit', (_, e) => {
    sent = e.text
    return { text: e.text, context: e.context }
  })
  const ui = await openPane($)
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)

  await ui.press({ key: `recent:${RECENT}` })
  const sips = fake.runs.find(argv => argv[0] === 'sips' && argv.includes(`${HOME}/Pictures/SnapCam/ClaudeSnaps/${RECENT}`))
  expect(sips).toContain(ORIGINAL)
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect((await ui.find({ key: `recent:${RECENT}` }))?.props.label).toMatch(/^✓/)
  await ui.press({ key: `recent:${RECENT}` })
  expect((await ui.find({ key: `recent:${RECENT}` }))?.props.label).toMatch(/^＋/)
  await ui.press({ key: `recent:${RECENT}` })
  await ui.unmount()

  await $.prompt.submit({ text: 'look', wait: false, origin: { kind: 'unclassified' } })
  expect(sent).toContain(`📷 ${RECENT}`)
})

test('an inbox photo pressed in the gallery leaves the tray, and comes back', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true)
  const ui = await openPane($)
  await clock.advance(3000)
  await ui.press({ key: 'tab:gallery' })

  expect((await ui.find({ key: `inbox:${A}` }))?.props.label).toMatch(/^✓/)
  await ui.press({ key: `inbox:${A}` })
  expect((await ui.find({ key: `inbox:${A}` }))?.props.label).toMatch(/^＋/)
  await ui.press({ key: `inbox:${A}` })
  expect((await ui.find({ key: `inbox:${A}` }))?.props.label).toMatch(/^✓/)
  await ui.unmount()
})

test('pane controls drive the camera through snapcam-cli', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  const ui = await openPane($)
  await clock.advance(1000)

  await ui.press({ key: 'lens:telephoto' })
  await ui.press({ key: 'zoom+' })
  await ui.press({ key: 'flash' })
  await ui.press({ key: 'light' })
  await ui.press({ key: 'ev+' })
  await ui.press({ key: 'ev0' })
  await ui.press({ key: 'shoot' })

  const own = fake.calls.filter(args => ['frame', 'flash', 'light', 'exposure', 'capture'].includes(args[0] ?? ''))
  expect(own.slice(0, 6)).toEqual([
    ['frame', '--lens', 'telephoto', '--json'],
    ['frame', '--zoom', '1.4', '--json'],
    ['flash', 'auto', '--json'],
    ['light', '0.3', '--json'],
    ['exposure', '0.5', '--json'],
    ['exposure', '0', '--json'],
  ])
  expect(own[6]?.[0]).toBe('capture')
  expect(own[6]).not.toContain('--source')
  await ui.unmount()
})

test('the camera button switches the live source and restarts the stream', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  const ui = await openPane($)
  await clock.advance(1000)

  await ui.press({ key: 'camera' })
  await clock.advance(1000)
  expect(fake.stopped).toBe(1)
  expect(fake.spawns.at(-1)).toContain('deskView')
  expect(await ui.find({ key: 'lens:wide' })).toBeUndefined()
  await ui.unmount()
})

test('on the terminal the video is an Image the frames blit into', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { surfaces: () => ['terminal'] })
  const ui = await openPane($, 'terminal')
  await clock.advance(1000)

  expect(fake.spawns[0]).toContain('--png')
  expect((await ui.find({ key: 'video' }))?.type).toBe('Image')
  expect(fake.blits.length).toBeGreaterThan(0)
  expect(fake.blits[0]).toMatchObject({ requestId: 'snap-live', key: 'video', source: { file: `${LIVE}/live.png`, format: 'png' } })
  await ui.unmount()
})

test('an old snapcam-cli without live shows why and is retried only after a pause', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { oldCli: true })
  const ui = await openPane($)
  await clock.advance(1000)

  expect(fake.spawns).toHaveLength(1)
  expect((await ui.find({ key: 'live' }))?.text).toContain('Обнови SnapCam для Mac')
  await clock.advance(3000)
  expect(fake.spawns).toHaveLength(1)
  await clock.advance(3000)
  expect(fake.spawns).toHaveLength(2)
  await ui.unmount()
})

test('a frame after an error clears it, on the terminal too', async ($, on) => {
  const clock = mock.clock(on)
  const frame = { seq: 3, preview: `${LIVE}/x/live.jpg`, png: `${LIVE}/x/live.png`, width: 640, height: 480, lens: 'wide', zoom: 1, phone: 'iPhone' }
  fakeMac(on, () => true, { surfaces: () => ['terminal'], tail: [{ error: 'Timed out', exit: '69' }, frame] })
  const ui = await openPane($, 'terminal')
  await clock.advance(1000)

  expect((await ui.find({ key: 'live' }))?.text ?? '').not.toContain('Timed out')
  await ui.unmount()
})

test('an error after frames shows over the frozen frame', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { tail: [{ error: 'Timed out. Is the camera still on?', exit: '69' }] })
  const ui = await openPane($)
  await clock.advance(1000)

  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect((await ui.find({ key: 'live' }))?.text).toContain('Камера не ответила вовремя. Она ещё включена?')
  await ui.unmount()
})

test('controls follow the stream: zoom steps from the lens and zoom set on the phone', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { live: { lens: 'telephoto', zoom: 5 } })
  const ui = await openPane($)
  await clock.advance(1000)

  expect((await ui.find({ key: 'lens:telephoto' }))?.props.variant).toBe('primary')
  await ui.press({ key: 'zoom+' })
  expect(fake.calls.find(args => args[0] === 'frame')).toEqual(['frame', '--zoom', '7', '--json'])
  await clock.advance(11_000)
  expect(fake.calls.filter(args => args[0] === 'state').length).toBeGreaterThan(1)
  await ui.unmount()
})

test('a surface that attaches restarts the stream with its flags', async ($, on) => {
  const clock = mock.clock(on)
  let surfaces: ('desktop' | 'terminal')[] = ['desktop']
  const fake = fakeMac(on, () => true, { surfaces: () => surfaces })
  const ui = await openPane($)
  await clock.advance(1000)
  expect(fake.spawns[0]).not.toContain('--png')

  surfaces = ['desktop', 'terminal']
  await clock.advance(1000)
  expect(fake.stopped).toBe(1)
  expect(fake.spawns.at(-1)).toContain('--png')
  await ui.unmount()
})

test('the terminal Image stays within 255 columns', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { surfaces: () => ['terminal'] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'snap', args: 'pane' } as never)
  const wide = { plugin: 'snap-cam', component: 'Pane', requestId: 'snap-live', props: { title: 'SnapCam', isFocused: false, bodyColumns: 400, placement: 'dock', scroll: { offset: 0, bodyRows: 400 }, view: {} } }
  const ui = await $.ui.mount({ ...wide, surface: 'terminal' } as never)
  await clock.advance(1000)

  expect((await ui.find({ key: 'video' }))?.props.columns).toBe(255)
  await ui.unmount()
})

test('the terminal video leaves room for the controls below it', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { surfaces: () => ['terminal'] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'snap', args: 'pane' } as never)
  const dock = { plugin: 'snap-cam', component: 'Pane', requestId: 'snap-live', props: { title: 'SnapCam', isFocused: false, bodyColumns: 200, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount({ ...dock, surface: 'terminal' } as never)
  await clock.advance(1000)

  const video = await ui.find({ key: 'video' })
  expect(video?.props.rows).toBe(30)
  expect(video?.props.columns).toBe(80)
  await ui.unmount()
})

test('a terminal that refuses file pictures gets the frame as bytes', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { surfaces: () => ['terminal'], bytesOnly: true })
  const ui = await openPane($, 'terminal')
  await clock.advance(1000)

  const sources = fake.blits.map(blit => Object.keys((blit as { source: object }).source)[0])
  expect(sources[0]).toBe('file')
  expect(sources.at(-1)).toBe('png')
  await ui.unmount()
})

test('a failed state read shows why, and the next good one clears it without launching the app', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { stateFails: 1 })
  const ui = await openPane($)
  await clock.advance(1000)
  expect((await ui.drawn()) && (await ui.find({ type: 'Text', text: /недоступны: SnapCam не запущен/ }))).toBeDefined()

  await clock.advance(11_000)
  expect(await ui.find({ type: 'Text', text: /недоступны/ })).toBeUndefined()
  const states = fake.calls.filter(args => args[0] === 'state')
  expect(states[0]).not.toContain('--no-launch')
  expect(states.at(-1)).toContain('--no-launch')
  await ui.unmount()
})

test('the band button opens the pane and starts the stream', async ($, on) => {
  const clock = mock.clock(on)
  const fake: Fake = fakeMac(on, () => fake.opened)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'snap-cam', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  await band.press({ key: 'snap-live' })
  await band.unmount()
  await clock.advance(1000)
  expect(fake.opened).toBe(true)
  expect(fake.spawns).toHaveLength(1)

})

test('an app message the pane has no translation for passes through', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { stateFails: 1, stateError: 'snapcam-cli: iPhone «Тест» не отвечает.' })
  const ui = await openPane($)
  await clock.advance(1000)

  expect(await ui.find({ type: 'Text', text: /iPhone «Тест» не отвечает\./ })).toBeDefined()
  await ui.unmount()
})

// The kit can't raise ui.close and loads its own module copy, so the handler runs on a stub.
test('closing the pane removes its frame folder', async () => {
  const runs: string[][] = []
  const engine = {
    env: { get: async () => HOME },
    process: { run: async (argv: string[]) => (runs.push(argv), { exitCode: 0, stdout: '', stderr: '' }) },
  }
  await closeLive(engine as never)
  const rm = runs.find(argv => argv[0] === 'rm') ?? []
  expect(rm.slice(0, 2)).toEqual(['rm', '-rf'])
  expect(rm[2]?.startsWith(`${LIVE}/`)).toBe(true)
  expect(rm[2]?.length).toBeGreaterThan(`${LIVE}/`.length)
})

test('a pane gone from the list stops the stream and the command starts a new one', async ($, on) => {
  let shown = true
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => shown)
  const ui = await openPane($)
  await clock.advance(1000)
  const dir = fake.spawns[0]?.[2] ?? ''
  expect(dir.startsWith(LIVE)).toBe(true)

  shown = false
  await clock.advance(6000)
  expect(fake.stopped).toBe(1)
  expect(fake.spawns).toHaveLength(1)
  await ui.unmount()

  shown = true
  const before = fake.calls.filter(args => args[0] === 'state').length
  await $.command.run({ command: 'snap', args: 'pane' } as never)
  await clock.advance(1000)
  const states = fake.calls.filter(args => args[0] === 'state')
  expect(states.length).toBeGreaterThan(before)
  expect(states.at(-1)).not.toContain('--no-launch')
  expect(fake.spawns).toHaveLength(2)
})

test('an external camera that state lists joins the source cycle', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { sources: [{ id: 'usb', kind: 'external', name: 'USB Camera', selected: false }] })
  const ui = await openPane($)
  await clock.advance(1000)

  await ui.press({ key: 'camera' })
  await clock.advance(1000)
  expect((await ui.find({ key: 'camera' }))?.props.label).toContain('внешняя камера')
  await ui.press({ key: 'camera' })
  await clock.advance(1000)
  const spawn = fake.spawns.at(-1) ?? []
  expect(spawn[spawn.indexOf('--source') + 1]).toBe('external')
  await ui.unmount()
})

test('the gallery reads the text of the newest photo', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  const ui = await openPane($)
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)

  await ui.press({ key: 'read' })
  expect(fake.calls.find(args => args[0] === 'ocr')).toEqual(['ocr', '--recent', '1', '--json'])
  expect((await ui.find({ key: 'read-text' }))?.text).toContain('Hello from the receipt')
  await ui.unmount()
})

test('a question asks about the attached photo', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  const ui = await openPane($)
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)
  await ui.press({ key: `recent:${RECENT}` })

  await ui.input({ key: 'question', text: 'Что купили?' })
  expect(fake.calls.find(args => args[0] === 'ask')).toEqual(['ask', ORIGINAL, '--json', '--question', 'Что купили?'])
  expect((await ui.find({ key: 'read-text' }))?.text).toContain('A grocery receipt.')
  await ui.unmount()
})

test('a failed question says why in Russian', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { askFails: true })
  const ui = await openPane($)
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)

  await ui.press({ key: 'ask' })
  expect(await ui.find({ type: 'Text', text: /Apple Intelligence выключен или недоступен/ })).toBeDefined()
  expect(await ui.find({ key: 'read-text' })).toBeUndefined()
  await ui.unmount()
})

test('two originals that share a name get their own gallery copies', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { recent: ['/D/IMG 1.heic', '/D/IMG 1.jpg'] })
  const ui = await openPane($)
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)

  expect(await ui.find({ key: 'recent:recent-IMG-1-heic.jpg' })).toBeDefined()
  expect(await ui.find({ key: 'recent:recent-IMG-1.jpg' })).toBeDefined()
  await ui.unmount()
})

test('stale frame folders of other sessions are swept once', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  const ui = await openPane($)
  await clock.advance(1000)
  await ui.press({ key: 'camera' })
  await clock.advance(1000)
  expect(fake.spawns.length).toBeGreaterThan(1)

  const own = (fake.spawns[0]?.[2] ?? '').slice(LIVE.length + 1)
  const sweeps = fake.runs.filter(argv => argv[0] === 'find')
  expect(sweeps).toHaveLength(1)
  const sweep = sweeps[0] ?? []
  expect(sweep[1]).toBe(LIVE)
  expect(sweep).toContain('-mmin')
  expect(sweep.join(' ')).toContain(`! -name ${own}`)
  await ui.unmount()
})
