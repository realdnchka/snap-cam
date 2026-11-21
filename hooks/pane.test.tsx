import { expect, mock, test } from 'claude-code/testing'

import { A, HOME, LIVE, ORIGINAL, RECENT, fakePaneMac as fakeMac, openPane } from './pane.fake.ts'

test('the pane streams live frames while its camera tab shows, and stops when hidden', async ($, on) => {
  let shown = true
  const clock = mock.clock(on)
  const fake = fakeMac(on, () => shown)
  const ui = await openPane($)
  await clock.advance(1000)

  expect(fake.calls.some(args => args[0] === 'state')).toBe(true)
  expect(fake.spawns).toHaveLength(1)
  expect(fake.spawns[0]).toEqual(['live', '--preview-dir', LIVE, '--preview-size', '640', '--fps', '5', '--json'])
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
  expect(fake.calls.find(args => args[0] === 'recent')).toEqual(['recent', '8', '--json'])
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

test('an error after frames shows over the frozen frame, and the next frame clears it', async ($, on) => {
  const clock = mock.clock(on)
  fakeMac(on, () => true, { tail: { error: 'Timed out. Is the camera still on?', exit: '69' } })
  const ui = await openPane($)
  await clock.advance(1000)

  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect((await ui.find({ key: 'live' }))?.text).toContain('Timed out')
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
  const wide = { plugin: 'snap-cam', component: 'Pane', requestId: 'snap-live', props: { title: 'SnapCam', isFocused: false, bodyColumns: 400, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount({ ...wide, surface: 'terminal' } as never)
  await clock.advance(1000)

  expect((await ui.find({ key: 'video' }))?.props.columns).toBe(255)
  await ui.unmount()
})
