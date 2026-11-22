import { expect, mock, test } from 'claude-code/testing'

import { A, HOME, LIVE, MODEL_OFF, ORIGINAL, RECENT, fakePaneMac as fakeMac, openPane, settle, stubEngine } from './pane.fake'
import type { Fake } from './pane.fake'
import { recentName } from './cli'
import { LIVE_PANE, closeLive, openLive, registerLive, startLiveClock } from './live'

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
  expect((await ui.drawn()) && (await ui.find({ type: 'Text', text: 'SnapCam не запущен.' }))).toBeDefined()

  await clock.advance(11_000)
  expect(await ui.find({ type: 'Text', text: /SnapCam не запущен/ })).toBeUndefined()
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

// The kit can't raise ui.close; the hook runs on its own module copy.
function closeHook() {
  const hooks = new Map<string, Function>()
  const register = (event: string, ...rest: Function[]) => {
    hooks.set(event, rest.at(-1) as Function)
    return { catch: () => undefined }
  }
  registerLive(register as never)
  const hook = hooks.get('ui.close')
  if (!hook) throw new Error('no ui.close hook')
  return hook as (s: never, e: { id: string; origin: { kind: string } }, next: (e: unknown) => unknown) => Promise<unknown>
}

test('closing the pane stops the stream and removes its frame folder', async () => {
  const hook = closeHook()
  const stub = stubEngine()
  await openLive(stub.$)
  await settle()
  expect(stub.spawns).toHaveLength(1)
  const dir = stub.spawns[0]?.[2] ?? ''
  expect(dir).toMatch(new RegExp(`^${LIVE}/[0-9a-f]{8}$`))

  const passed: unknown[] = []
  await hook(stub.$, { id: LIVE_PANE, origin: { kind: 'person' } }, e => passed.push(e))
  expect(stub.kills).toBe(1)
  expect(stub.runs).toContainEqual(['rm', '-rf', dir])
  // A poll still running would bring the folder back: rm only after the child is gone.
  expect(stub.events.indexOf(`rm -rf ${dir}`)).toBeGreaterThan(stub.events.indexOf('kill'))
  expect(passed).toHaveLength(1)
})

test('a closed pane stays closed: later ticks and state changes neither reopen nor restream it', async () => {
  const hook = closeHook()
  const stub = stubEngine()
  startLiveClock(stub.$)
  await openLive(stub.$)
  await settle()
  expect(stub.opens).toBe(1)
  expect(stub.spawns).toHaveLength(1)
  const states = () => stub.runs.filter(argv => argv[1] === 'state').length
  const before = states()

  // The engine still lists the pane while its close chain runs.
  let passed = 0
  const closing = hook(stub.$, { id: LIVE_PANE, origin: { kind: 'person' } }, async () => {
    passed += 1
    await stub.tick()
  })
  await closing
  expect(passed).toBe(1)
  expect(stub.kills).toBe(1)

  for (let i = 0; i < 5; i += 1) await stub.tick()
  const { state } = stub.$ as unknown as { state: { set: (ref: object, value: unknown) => Promise<unknown> } }
  await state.set({ plugin: 'snap-cam', key: 'paneCamera' }, 'desk')
  await state.set({ plugin: 'snap-cam', key: 'paneTab' }, 'camera')
  for (let i = 0; i < 5; i += 1) await stub.tick()
  expect(stub.opens).toBe(1)
  expect(stub.spawns).toHaveLength(1)
  expect(states()).toBe(before)

  // Only the person's open brings it back.
  await openLive(stub.$)
  await settle()
  expect(stub.opens).toBe(2)
  expect(stub.spawns).toHaveLength(2)
})

test('closing another pane leaves the stream running', async () => {
  const hook = closeHook()
  const stub = stubEngine()
  await openLive(stub.$)
  await settle()
  expect(stub.spawns).toHaveLength(1)

  await hook(stub.$, { id: 'other', origin: { kind: 'person' } }, () => undefined)
  await settle()
  expect(stub.kills).toBe(0)
  expect(stub.runs.some(argv => argv[0] === 'rm' && argv[1] === '-rf')).toBe(false)

  await closeLive(stub.$)
  await settle()
  expect(stub.kills).toBe(1)
})

test('closing twice kills once and removes the folder each time', async () => {
  const stub = stubEngine()
  await openLive(stub.$)
  await settle()
  await closeLive(stub.$)
  await closeLive(stub.$)
  await settle()
  expect(stub.kills).toBe(1)
  expect(stub.runs.filter(argv => argv[0] === 'rm')).toHaveLength(2)
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

test('every external camera that state lists joins the source cycle by its id and name', async ($, on) => {
  const clock = mock.clock(on)
  const externals = [
    { id: 'usb', kind: 'external', name: 'USB Camera', selected: false },
    { id: 'cap', kind: 'external', name: 'Capture Card', selected: false },
  ]
  const fake = fakeMac(on, () => true, { sources: externals })
  const ui = await openPane($)
  await clock.advance(1000)

  await ui.press({ key: 'camera' })
  await clock.advance(1000)
  expect((await ui.find({ key: 'camera' }))?.props.label).toBe('↻ USB Camera')
  await ui.press({ key: 'camera' })
  await clock.advance(1000)
  let spawn = fake.spawns.at(-1) ?? []
  expect(spawn[spawn.indexOf('--source') + 1]).toBe('usb')
  expect((await ui.find({ key: 'status' }))?.text).toContain('USB Camera')
  expect((await ui.find({ key: 'camera' }))?.props.label).toBe('↻ Capture Card')

  await ui.press({ key: 'shoot' })
  const capture = fake.calls.find(args => args[0] === 'capture') ?? []
  expect(capture[capture.indexOf('--source') + 1]).toBe('usb')

  await ui.press({ key: 'camera' })
  await clock.advance(1000)
  spawn = fake.spawns.at(-1) ?? []
  expect(spawn[spawn.indexOf('--source') + 1]).toBe('cap')
  expect((await ui.find({ key: 'camera' }))?.props.label).toBe('↻ iPhone')
  await ui.unmount()
})

test('with nothing attached the gallery reads the text of the last shot', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { noInbox: true })
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
  const said = 'Apple Intelligence выключен. Включи его в Системных настройках › Apple Intelligence и Siri и попробуй снова.'
  expect((await ui.find({ type: 'Text', text: /Apple Intelligence/ }))?.text).toBe(said)
  expect(JSON.stringify(await ui.drawn())).not.toContain(MODEL_OFF)
  expect(await ui.find({ key: 'read-text' })).toBeUndefined()
  await ui.unmount()
})

test('two originals that share a name get their own gallery copies', async ($, on) => {
  const clock = mock.clock(on)
  const originals = ['/D/IMG 1.heic', '/D/IMG 1.jpg', '/D/IMG-1.jpg']
  fakeMac(on, () => true, { recent: originals })
  const ui = await openPane($)
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)

  const keys = originals.map(original => `recent:${recentName(original)}`)
  expect(new Set(keys).size).toBe(3)
  for (const key of keys) expect(await ui.find({ key })).toBeDefined()
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

test('a live error the pane has no words for is told by its exit code', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { tail: [{ error: 'x', exit: '75' }] })
  const ui = await openPane($)
  await clock.advance(1000)

  expect((await ui.find({ key: 'live' }))?.text).toContain('iPhone не подключился вовремя.')
  await ui.unmount()
})

test('a live child that ends with a reason on stderr shows it in Russian', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { exit: { code: 69, stderr: "snapcam-cli: SnapCam isn't running." } })
  const ui = await openPane($)
  await clock.advance(1000)

  expect((await ui.find({ key: 'live' }))?.text).toContain('SnapCam не запущен.')
  await ui.unmount()
})

test('the gallery reads one photo at a time', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { ocrDelay: 20 })
  const ui = await openPane($)
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)

  await Promise.all([ui.press({ key: 'read' }), ui.press({ key: 'read' })])
  expect(fake.calls.filter(args => args[0] === 'ocr')).toHaveLength(1)
  expect((await ui.find({ key: 'read-text' }))?.text).toBe('Фото: SnapCam 2026-11-22 at 10.00.01.heic\nHello from the receipt')
  await ui.unmount()
})

test('an inbox photo attached in the gallery is the one read', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true)
  const ui = await openPane($)
  await clock.advance(3000)
  await ui.press({ key: 'tab:gallery' })
  expect((await ui.find({ key: `inbox:${A}` }))?.props.label).toMatch(/^✓/)

  await ui.press({ key: 'read' })
  expect(fake.calls.find(args => args[0] === 'ocr')).toEqual(['ocr', '/Pictures/SnapCam/Default/a.heic', '--json'])
  expect(await ui.find({ key: 'read-text' })).toBeDefined()
  // Another attachment: the old answer goes.
  await ui.press({ key: `inbox:${A}` })
  expect(await ui.find({ key: 'read-text' })).toBeUndefined()
  await ui.unmount()
})

test('on a phone the gallery has no question field', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { surfaces: () => ['mobile'] })
  const ui = await openPane($, 'mobile')
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)

  expect(await ui.find({ key: 'ask' })).toBeDefined()
  expect(await ui.find({ key: 'question' })).toBeUndefined()
  await ui.unmount()
})

test('on the terminal the band and the preview pane draw no Svg', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { surfaces: () => ['terminal'] })
  const ui = await openPane($, 'terminal')
  await clock.advance(1000)
  await ui.press({ key: 'shoot' })
  await ui.unmount()

  const band = await $.ui.mount({ plugin: 'snap-cam', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  expect(await band.find({ type: 'Svg' })).toBeUndefined()
  const zoom = (await band.findAll({ type: 'Button' })).find(button => String(button.key).startsWith('zoom:'))
  expect(zoom).toBeDefined()
  await band.press({ key: String(zoom?.key) })
  await band.unmount()

  const preview = await $.ui.mount({
    plugin: 'snap-cam', surface: 'terminal', component: 'Pane', requestId: 'snap-preview',
    props: { title: 'SnapCam', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  expect(await preview.find({ type: 'Svg' })).toBeUndefined()
  expect((await preview.find({ type: 'Text' }))?.text).toMatch(/^iphone-.*\.jpg$/)
  expect(fake.reads.some(path => path.includes('/previews/'))).toBe(false)
  await preview.unmount()
})

test('a fresh shot is read before an older attached gallery photo', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { noInbox: true })
  const ui = await openPane($)
  await clock.advance(1000)
  await ui.press({ key: 'shoot' })
  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)
  await ui.press({ key: `recent:${RECENT}` })

  await ui.press({ key: 'read' })
  expect(fake.calls.find(args => args[0] === 'ocr')).toEqual(['ocr', '/o.heic', '--json'])
  await ui.unmount()
})

test('without SnapCam for Mac the shot and the read say so in Russian', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => true, { noCli: true })
  const ui = await openPane($)
  await clock.advance(1000)
  await ui.press({ key: 'shoot' })
  const shot = await ui.find({ type: 'Text', text: /не установлен: собери/ })
  expect(shot?.text).toBe('SnapCam: SnapCam для Mac не установлен: собери его в snapcam-app скриптом scripts/install-mac.sh')

  await ui.press({ key: 'tab:gallery' })
  await clock.advance(1000)
  await ui.press({ key: 'read' })
  expect((await ui.find({ type: 'Text', text: /не установлен/ }))?.text).toBe('SnapCam для Mac не установлен: собери его в snapcam-app скриптом scripts/install-mac.sh')
  expect(fake.calls).toHaveLength(0)
  expect(JSON.stringify(await ui.drawn())).not.toContain('is not installed')
  await ui.unmount()
})

test('a stream error and a failed state read show one Russian message, not both', async ($, on) => {
  const clock = mock.clock(on)
  const english = 'No paired iPhone nearby. Open SnapCam on the iPhone.'
  fakeMac(on, () => true, { stateFails: 1, stateError: `snapcam-cli: ${english}`, tail: [{ error: english, exit: '69' }] })
  const ui = await openPane($)
  await clock.advance(1000)

  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain(english)
  expect(drawn.split('SnapCam для Mac, iPhone или камера недоступны.').length - 1).toBe(1)
  await ui.unmount()
})
