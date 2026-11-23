import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CameraInfo, Framing, InboxItem, LiveFrame, PaneTab, RecentItem, SnapMode } from '../types'
import {
  CLI_USAGE, INSTALL, READ_TIMEOUT_S, SHORT, SIDE, SOURCES, baseName, chipSvg, findCli, makeThumb, paneFailure,
  paneOcrText, parseJson, paths, recentName, runCli, snapToTray, times,
} from './cli'
import type { PhotoText } from './cli'

const cameraInfo = atom({ plugin: 'snap-cam', key: 'cameraInfo' } as const, null as CameraInfo | null)
const dismissed = atom({ plugin: 'snap-cam', key: 'dismissed' } as const, [] as string[])
const gallery = atom({ plugin: 'snap-cam', key: 'gallery' } as const, [] as RecentItem[])
const inbox = atom({ plugin: 'snap-cam', key: 'inbox' } as const, [] as InboxItem[])
const liveFrame = atom({ plugin: 'snap-cam', key: 'liveFrame' } as const, { seq: 0 } as LiveFrame)
const paneCamera = atom({ plugin: 'snap-cam', key: 'paneCamera' } as const, 'iphone' as SnapMode)
// The camera id within `paneCamera`, for one of several external cameras; '' otherwise.
const paneSource = atom({ plugin: 'snap-cam', key: 'paneSource' } as const, '')
const paneNote = atom({ plugin: 'snap-cam', key: 'paneNote' } as const, '')
const paneTab = atom({ plugin: 'snap-cam', key: 'paneTab' } as const, 'camera' as PaneTab)
const paneText = atom({ plugin: 'snap-cam', key: 'paneText' } as const, '')
const pending = atom({ plugin: 'snap-cam', key: 'pending' } as const, [] as string[])
// Attached shot previews → originals; written by snapToTray in cli.ts.
const shotOriginals = atom({ plugin: 'snap-cam', key: 'shotOriginals' } as const, {} as Record<string, string>)
const phoneTray = atom({ plugin: 'snap-cam', key: 'phoneTray' } as const, [] as InboxItem[])

export const LIVE_PANE = 'snap-live'
const TITLE = '📷 SnapCam'
const FPS = 5
const LIVE_SIDE = 640
// Svg.source limit; a bigger frame is skipped.
const SVG_MAX = 131_072
const TICK_MS = 1000
// Tabs, status, shoot, camera, lens and light rows under the terminal video.
const CONTROL_ROWS = 12
const GALLERY_COUNT = 8
const GALLERY_EVERY_MS = 15_000
const ZOOM_STEP = 1.4
const EV_STEP = 0.5
// Light stepper levels; 0 is light and flash off.
const LIGHT_STEPS = [0, 0.25, 0.5, 0.75, 1]
const CHIP = 72
const LENS_LABEL: Record<string, string> = { ultraWide: 'ultra', wide: 'wide', telephoto: 'tele' }
const SOURCE_MODES: Record<string, SnapMode> = {
  phone: 'iphone', continuity: 'continuity', deskView: 'desk', builtIn: 'mac', external: 'external',
}

type LiveLine = LiveFrame & { error?: string; exit?: string }
type StateJson = {
  phone?: string
  caps?: {
    lenses?: { kind: string; displayZoom: number }[]
    zoom?: { min: number; max: number }
    flashModes?: string[]
    hasTorch?: boolean
    maxLightLevel?: number
    exposure?: { min: number; max: number }
  }
  framing?: Framing
  sources?: { id?: string; kind: string; name: string }[]
}
type RecentJson = { items?: { original: string }[] }

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

type Run = {
  stream: AsyncGenerator<unknown, unknown>
  mode: SnapMode
  source: string
  stopped: boolean
  everyFrame: boolean
  blit: boolean
  // iTerm2 and tmux read only bytes: switched on after a refused file blit.
  bytes: boolean
  denials: number
}
// Blits refused in a row before the pane stops sending them.
const MAX_DENIALS = 10
// Per module load, so two sessions don't share frame files.
const LIVE_ID = crypto.randomUUID().slice(0, 8)
// Last frame that fit Svg's limit, shown while a bigger one is skipped.
let lastSvg: string | null = null
// Who wrote the note, so their next success clears it.
let noteFrom = ''
let run: Run | null = null
// A child that ended by itself is restarted no sooner than this.
let retryAt = 0
const RETRY_MS = 5000
const INFO_EVERY_MS = 10_000
// While the phone's caps are unknown, `state` is read this often.
const INFO_WAIT_MS = 2000
// Rough CSS px per pane column on desktop.
const CELL_PX = 8
let ticking = false
// The terminal refused a file source once: draw from bytes.
let terminalBytes = false
// A press or close came while a tick ran: tick once more after it.
let again = false
// Bumped by every stop, so a start still in its awaits gives up.
let startGen = 0
// When `state` was last read for the controls; null reads it now.
let infoAt: number | null = null
let refreshing = false
let infoBusy = false
// Set by openLive: the first `state` after an open may launch the app.
let launchNext = false
// When the gallery was last read; null reads it at the next chance.
let galleryAt: number | null = null
// Frame folders of crashed sessions are swept once per module load.
let swept = false
// Live folders older than this belong to no running session.
const STALE_MINUTES = 10
// The gallery's question for `ask`; empty summarizes.
let question = ''
let reading = false
// The attached photos the shown answer is about; another set hides it.
let textFor = ''
// How long a close waits for the child to die before removing its folder.
const KILL_WAIT_MS = 2000
// Set by a close, cleared only by openLive: ticks never revive a closed pane.
let closed = false

// Stops the child; resolves once it is gone or after KILL_WAIT_MS.
function stopLive($: EngineInterface): Promise<void> {
  startGen += 1
  if (!run) return Promise.resolve()
  run.stopped = true
  const killed = run.stream.return(undefined).then(() => {}, () => {})
  run = null

  return Promise.race([killed, $.clock.sleep(KILL_WAIT_MS).catch(() => {})])
}

// `--source` for the stream and shots: an external camera's id, else the mode's source.
function sourceOf(mode: SnapMode, id: string): string {
  return mode === 'external' && id ? id : SOURCES[mode].source
}

async function startLive($: EngineInterface, mode: SnapMode, id: string, surfaces: readonly string[]): Promise<void> {
  const gen = startGen
  const p = await paths($)
  const cli = await findCli($, p)
  if (!cli) {
    await ended($, "SnapCam for Mac isn't installed.")
    return
  }
  if (gen !== startGen) return
  if (!swept) {
    swept = true
    // A running CLI touches its folder every poll, errors included, and recreates it if swept.
    const stale = ['find', `${p.dir}/live`, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '!', '-name', LIVE_ID]
    void $.process.run([...stale, '-mmin', `+${STALE_MINUTES}`, '-exec', 'rm', '-rf', '{}', '+']).catch(() => {})
  }
  const blit = surfaces.includes('terminal')
  const wanted = sourceOf(mode, id)
  const source = mode === 'iphone' ? [] : ['--source', wanted]
  const argv = [cli, 'live', '--preview-dir', `${p.dir}/live/${LIVE_ID}`, '--preview-size', String(LIVE_SIDE)]
  argv.push('--fps', String(FPS), '--json', ...(blit ? ['--png'] : []), ...source)
  const stream = $.process.spawn({ argv })
  const me: Run = { stream, mode, source: wanted, stopped: false, everyFrame: surfaces.some(s => s !== 'terminal'), blit, bytes: false, denials: 0 }
  run = me
  await update($, liveFrame, () => ({ seq: 0 }))
  void (async () => {
    let buffer = ''
    let stderr = ''
    try {
      for await (const chunk of stream) {
        if (me.stopped) break
        if (chunk.stream !== 'stdout') {
          stderr = (stderr + chunk.text).slice(-500)
          continue
        }
        buffer += chunk.text
        for (let at = buffer.indexOf('\n'); at >= 0 && !me.stopped; at = buffer.indexOf('\n')) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          await onLine($, me, parseJson<LiveLine>(line))
        }
      }
      if (!me.stopped) {
        const { code } = await stream.result
        const last = (stderr.trim().split('\n').pop() ?? '').replace(/^snapcam-cli: /, '')
        const why =
          code === CLI_USAGE ? 'Update SnapCam for Mac: this snapcam-cli has no live video.'
          : paneFailure({ exitCode: code ?? 1, reason: last })
        await ended($, why)
      }
    } catch (error) {
      // Also an unload: $ may be gone, so nothing may throw from here.
      if (!me.stopped) await ended($, "Couldn't start SnapCam live video.").catch(() => {})
    } finally {
      if (run === me) run = null
    }
  })()
}

async function ended($: EngineInterface, why: string): Promise<void> {
  retryAt = (await $.clock.now()) + RETRY_MS
  await update($, liveFrame, f => ({ ...f, error: why }))
}

async function onLine($: EngineInterface, me: Run, line: Partial<LiveLine>): Promise<void> {
  if (line.error) {
    const error = paneFailure({ exitCode: Number(line.exit ?? 1), reason: line.error })
    await update($, liveFrame, f => (f.error === error ? f : { ...f, error }))
    return
  }
  if (!line.preview || !line.seq) return
  const next: LiveFrame = {
    seq: line.seq, preview: line.preview, png: line.png, width: line.width, height: line.height,
    lens: line.lens, zoom: line.zoom, phone: line.phone,
  }
  if (me.blit && line.png) void blitFrame($, me, line.png, line.seq)
  const before = await read($, liveFrame)
  // The camera came up: read its caps now, not at the next poll.
  if (before.error || before.seq === 0) {
    const info = await read($, cameraInfo)
    if (before.error || (me.mode === 'iphone' && !info?.lenses.length)) infoAt = null
  }
  // The terminal swaps the picture by blit; redraw only when the words or the shape change.
  await update($, liveFrame, f => {
    const same =
      f.lens === next.lens && f.zoom === next.zoom && f.phone === next.phone && f.width === next.width &&
      f.height === next.height && !f.error && f.seq > 0
    return !me.everyFrame && same ? f : next
  })
}

// A file source first; a refusal switches to bytes, repeated refusals stop the blits.
async function blitFrame($: EngineInterface, me: Run, png: string, seq: number): Promise<void> {
  try {
    const source = me.bytes
      ? { png: (await $.fs.read(png, { as: 'bytes' })).base64 }
      : { file: png, format: 'png' as const, generation: seq }
    const done = await $.ui.blit({ requestId: LIVE_PANE, key: 'video', source })
    if (!('deny' in done) || !done.deny) {
      me.denials = 0
      return
    }
    if (!me.bytes) {
      me.bytes = true
      terminalBytes = true
      return
    }
    me.denials += 1
    if (me.denials >= MAX_DENIALS) me.blit = false
  } catch {
    // A frame lost; the next one tries again.
  }
}

// Streams only while the pane shows its camera tab.
async function tick($: EngineInterface): Promise<void> {
  if (ticking) {
    again = true
    return
  }
  ticking = true
  try {
    const pane = (await $.ui.panes()).find(one => one.id === LIVE_PANE)
    // A closing pane is still listed until its ui.close chain ends.
    const shown = !closed && !!pane && pane.isShown && pane.isPlaced
    const tab = await read($, paneTab)
    const mode = await read($, paneCamera)
    const id = await read($, paneSource)
    const surfaces = await $.session.surfaces()
    // A surface came or went: restart with its flags.
    // Only --png needs a new child; the redraw policy changes in place.
    if (run) run.everyFrame = surfaces.some(s => s !== 'terminal')
    const changed = run && run.blit !== surfaces.includes('terminal') && run.denials < MAX_DENIALS
    const moved = run && (run.mode !== mode || run.source !== sourceOf(mode, id))
    if (run && (!shown || tab !== 'camera' || moved || changed)) void stopLive($)
    const now = await $.clock.now()
    const info = await read($, cameraInfo)
    const every = mode === 'iphone' && !info?.lenses.length ? INFO_WAIT_MS : INFO_EVERY_MS
    if (shown && tab === 'camera' && !infoBusy && (infoAt === null || now - infoAt > every)) {
      infoAt = now
      void refreshInfo($).catch(() => {})
    }
    if (shown && tab === 'camera' && !run && now >= retryAt) await startLive($, mode, id, surfaces)
    if (shown && tab === 'gallery' && (galleryAt === null || now - galleryAt > GALLERY_EVERY_MS)) void refreshGallery($).catch(() => {})
  } catch {
    // Next tick tries again.
  } finally {
    ticking = false
    if (again) {
      again = false
      void tick($)
    }
  }
}

function toInfo(json: Partial<StateJson>): CameraInfo {
  const caps = json.caps
  const sources: CameraInfo['sources'] = []
  for (const one of json.sources ?? []) {
    const mode = SOURCE_MODES[one.kind]
    // Every external camera by id; one entry for each other kind.
    if (mode === 'external' && one.id) {
      if (!sources.some(s => s.id === one.id)) sources.push({ mode, name: one.name, id: one.id })
    } else if (mode && !sources.some(s => s.mode === mode)) {
      sources.push({ mode, name: one.name })
    }
  }
  if (!sources.some(s => s.mode === 'iphone')) sources.unshift({ mode: 'iphone', name: 'iPhone' })

  return {
    phone: json.phone,
    lenses: (caps?.lenses ?? []).map(lens => ({ kind: lens.kind, zoom: lens.displayZoom })),
    zoomMin: caps?.zoom?.min ?? 1,
    zoomMax: caps?.zoom?.max ?? 1,
    flashModes: caps?.flashModes ?? [],
    hasLight: !!caps?.hasTorch || (caps?.maxLightLevel ?? 0) > 0,
    exposureMin: caps?.exposure?.min,
    exposureMax: caps?.exposure?.max,
    framing: json.framing,
    sources,
  }
}

async function setNote($: EngineInterface, from: string, text: string): Promise<void> {
  if (!text && noteFrom !== from) return
  noteFrom = text ? from : ''
  await update($, paneNote, () => text)
}

async function refreshInfo($: EngineInterface): Promise<void> {
  if (infoBusy) return
  infoBusy = true
  try {
    const p = await paths($)
    const cli = await findCli($, p)
    if (!cli) return
    // Polls never start the app; only the first read after an open may.
    const launch = launchNext
    launchNext = false
    const res = await runCli($, cli, ['state', '--json', ...(launch ? [] : ['--no-launch'])], 30)
    if (res.exitCode !== 0) {
      await setNote($, 'state', paneFailure(res))
      return
    }
    await update($, cameraInfo, () => toInfo(parseJson<StateJson>(res.stdout)))
    await setNote($, 'state', '')
  } finally {
    infoBusy = false
  }
}

// The newest photos of the save folder; thumbs made once per original.
async function refreshGallery($: EngineInterface): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    await readGallery($)
  } finally {
    refreshing = false
  }
}

async function readGallery($: EngineInterface): Promise<void> {
  galleryAt = await $.clock.now()
  const p = await paths($)
  const cli = await findCli($, p)
  if (!cli) return
  const res = await runCli($, cli, ['recent', String(GALLERY_COUNT), '--json', '--no-launch'], 30)
  if (res.exitCode !== 0) {
    await setNote($, 'recent', paneFailure(res))
    return
  }
  await setNote($, 'recent', '')
  const items: RecentItem[] = (parseJson<RecentJson>(res.stdout).items ?? []).map(item => ({
    original: item.original,
    name: recentName(item.original),
  }))
  for (const item of items) {
    if (!(await $.fs.exists(`${p.thumbs}/${item.name}`))) await makeThumb($, p, item.original, item.name)
  }
  await update($, gallery, list =>
    list.length === items.length && list.every((one, i) => one.original === items[i]?.original) ? list : items,
  )
}

// One camera command; its framing answer updates the controls.
async function control($: EngineInterface, args: string[]): Promise<void> {
  const p = await paths($)
  const cli = await findCli($, p)
  if (!cli) return
  const res = await runCli($, cli, [...args, '--json'], 30)
  if (res.exitCode !== 0) {
    await setNote($, 'control', paneFailure(res))
    return
  }
  const framing = parseJson<{ framing: Framing }>(res.stdout).framing
  await setNote($, 'control', '')
  if (framing) await update($, cameraInfo, info => (info ? { ...info, framing } : info))
}

async function toggleRecent($: EngineInterface, item: RecentItem): Promise<void> {
  await update($, paneText, () => '')
  const p = await paths($)
  const dest = `${p.snaps}/${item.name}`
  if ((await read($, pending)).includes(dest)) {
    await update($, pending, list => list.filter(one => one !== dest))
    return
  }
  await $.process.run(['mkdir', '-p', p.snaps])
  await $.process.run(['sips', '-s', 'format', 'jpeg', '-Z', String(SIDE), item.original, '--out', dest])
  if (!(await $.fs.exists(dest))) {
    await setNote($, 'control', `Couldn't read ${baseName(item.original)}`)
    return
  }
  await update($, pending, list => (list.includes(dest) ? list : [...list, dest]))
}

// What the answer is about: the attached gallery and inbox photos.
async function attachedKey($: EngineInterface): Promise<string> {
  const shots = await read($, pending)
  const tray = (await read($, phoneTray)).map(item => item.id)

  return [...shots, ...tray].sort().join('\n')
}

// The newest attached photo: a shot, gallery or inbox; else the last shot.
async function readTarget($: EngineInterface): Promise<string[]> {
  const p = await paths($)
  const list = await read($, pending)
  const attached = new Set(list)
  const known = await read($, shotOriginals)
  const shots = list.filter(path => known[path]).map(path => known[path] as string)
  const tray = await read($, phoneTray)
  const originals = new Set([...shots, ...tray.map(item => item.original)])
  const listed = await read($, gallery)
  // A shot not yet in the gallery is newer than anything listed there.
  const unlisted = shots.filter(original => !listed.some(item => item.original === original)).at(-1)
  if (unlisted) return [unlisted]
  // The gallery lists the save folder newest first; shot and inbox originals live there too.
  const shown = listed.find(item => attached.has(`${p.snaps}/${item.name}`) || originals.has(item.original))
  if (shown) return [shown.original]
  // Not among the newest few: the inbox lists oldest first.
  const order = (await read($, inbox)).map(item => item.id)
  const newest = [...tray].sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id))[0]

  return newest ? [newest.original] : ['--recent', '1']
}

// Gallery `read` (OCR) or `ask` (the Mac's model), answered under the buttons.
async function readPhoto($: EngineInterface, what: 'read' | 'ask'): Promise<void> {
  if (reading) return
  reading = true
  try {
    const p = await paths($)
    const cli = await findCli($, p)
    if (!cli) {
      await setNote($, 'read', INSTALL)
      return
    }
    await update($, paneText, () => (what === 'read' ? 'Reading…' : 'Thinking…'))
    textFor = await attachedKey($)
    const target = await readTarget($)
    const asked = question.trim()
    const argv =
      what === 'read' ? ['ocr', ...target, '--json'] : ['ask', ...target, '--json', ...(asked ? ['--question', asked] : [])]
    const res = await runCli($, cli, argv, READ_TIMEOUT_S)
    if (res.exitCode !== 0) {
      await update($, paneText, () => '')
      await setNote($, 'read', paneFailure(res))
      return
    }
    await setNote($, 'read', '')
    if (what === 'read') {
      await update($, paneText, () => paneOcrText(parseJson<{ photos: PhotoText[] }>(res.stdout).photos ?? []))
    } else {
      const json = parseJson<{ answer: string; photos: string[] }>(res.stdout)
      const names = (json.photos ?? []).map(baseName).join(', ')
      await update($, paneText, () => `${json.answer ?? ''}${names ? `\n\nPhoto: ${names}` : ''}`)
    }
  } catch {
    await update($, paneText, () => '')
    await setNote($, 'read', "Couldn't read the photo.")
  } finally {
    reading = false
  }
}

// A tray photo off goes to `dismissed`; back on leaves it.
async function toggleInbox($: EngineInterface, item: InboxItem): Promise<void> {
  await update($, paneText, () => '')
  const attached = (await read($, phoneTray)).some(one => one.id === item.id)
  if (attached) {
    await update($, dismissed, list => (list.includes(item.id) ? list : [...list, item.id]))
    await update($, phoneTray, list => list.filter(one => one.id !== item.id))
  } else {
    await update($, dismissed, list => list.filter(id => id !== item.id))
    await update($, phoneTray, list => (list.some(one => one.id === item.id) ? list : [...list, item]))
  }
}

export async function openLive($: EngineInterface): Promise<boolean> {
  closed = false
  const opened = await $.ui.open({ id: LIVE_PANE, title: TITLE })
  infoAt = null
  launchNext = true
  void tick($)

  return opened.isPlaced
}

async function videoSvg($: EngineInterface, frame: LiveFrame): Promise<string | null> {
  // A frame mid-write keeps the last picture, so the layout never collapses.
  if (!frame.preview || !frame.width || !frame.height || !(await $.fs.exists(frame.preview))) return lastSvg
  const { base64 } = await $.fs.read(frame.preview, { as: 'bytes' })
  const { width: w, height: h } = frame
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image width="${w}" height="${h}" href="data:image/jpeg;base64,${base64}"/></svg>`

  if (svg.length <= SVG_MAX) lastSvg = svg

  return lastSvg
}

// The state's name for an external camera, else the short one.
function sourceName(info: CameraInfo | null, id: string): string {
  return info?.sources.find(s => s.id === id && id)?.name ?? SHORT.external
}

function framingLine(frame: LiveFrame, info: CameraInfo | null, mode: SnapMode, id: string): string {
  const f = info?.framing
  // Externals by the state's name: the stream reports none of its own for them.
  const name = mode === 'external' ? sourceName(info, id) : frame.phone ?? (mode === 'iphone' ? info?.phone : undefined) ?? SHORT[mode]
  const parts = [name]
  if (mode === 'iphone' && f) {
    parts.push(`${LENS_LABEL[f.lens ?? ''] ?? f.lens ?? ''} ${times(frame.zoom ?? f.zoom)}`.trim())
    parts.push(`flash ${f.flash}`)
    if (f.light > 0) parts.push(`light ${Math.round(f.light * 100)}%`)
    if (f.exposure !== 0) parts.push(`${f.exposure > 0 ? '+' : ''}${f.exposure} EV`)
  }

  return parts.join(' · ')
}

// Called from session.start in interactive sessions.
export function startLiveClock($: EngineInterface): void {
  $.clock.every(TICK_MS, () => void tick($))
}

// Pane closed: kill the stream first, or a running poll recreates the folder.
export async function closeLive($: EngineInterface): Promise<void> {
  closed = true
  const stopped = stopLive($)
  infoAt = null
  lastSvg = null
  const p = await paths($)
  await stopped
  await $.process.run(['rm', '-rf', `${p.dir}/live/${LIVE_ID}`]).catch(() => {})
}

export function registerLive(on: On): void {
  // Close at once; the cleanup runs after, so nothing holds the pane open meanwhile.
  on('ui.close', async ($, e, next) => {
    if (e.id !== LIVE_PANE) return next(e)
    const cleanup = closeLive($)
    const done = await next(e)
    // The close already went through; a failed cleanup must not run next twice.
    await cleanup.catch(() => {})

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: LIVE_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input } = ui
    // The terminal has Image, not Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const Image = e.surface === 'terminal' && 'Image' in ui ? ui.Image : null
    const tab = await read($, paneTab)
    const mode = await read($, paneCamera)
    const id = await read($, paneSource)
    const info = await read($, cameraInfo)
    const note = await read($, paneNote)
    const frame = await read($, liveFrame)
    const terminal = e.surface === 'terminal'
    const setTab = (next: 'camera' | 'gallery') => async () => {
      await update($, paneTab, () => next)
      await tick($)
    }
    const tabs = (
      <Box key="tabs" flexDirection="row" gap={1}>
        <Button key="tab:camera" label="🎥 Camera" variant={tab === 'camera' ? 'primary' : undefined} onPress={setTab('camera')} />
        <Button key="tab:gallery" label="🖼 Gallery" variant={tab === 'gallery' ? 'primary' : undefined} onPress={setTab('gallery')} />
        {/* The desktop tab mark may not close a plugin pane. */}
        {e.surface === 'desktop' && <Button key="close" label="✕ Close" plain dimColor onPress={() => void $.ui.close({ id: LIVE_PANE })} />}
      </Box>
    )
    const noteRow = note ? <Text color="red">{note}</Text> : null

    if (tab === 'gallery') {
      const recent = await read($, gallery)
      const listed = await read($, inbox)
      const tray = new Set((await read($, phoneTray)).map(item => item.id))
      const p = await paths($)
      const attached = new Set(await read($, pending))
      const chip = async (name: string) => (terminal ? null : await chipSvg($, name, CHIP))
      const inboxChips = await Promise.all(listed.map(item => chip(item.name)))
      const recentChips = await Promise.all(recent.map(item => chip(item.name)))
      // Read always, so the answer redraws; one about other attachments is stale.
      const answer = await read($, paneText)
      const text = (await attachedKey($)) === textFor ? answer : ''

      const readRow = (
        <Box key="read-row" flexDirection="row" gap={1} alignItems="center">
          <Button key="read" label="📝 Text" onPress={() => readPhoto($, 'read')} />
          <Button key="ask" label="✨ Ask" onPress={() => readPhoto($, 'ask')} />
          {e.surface !== 'mobile' && (
            <Input
              key="question"
              placeholder="Question (empty for a summary)"
              value={question}
              submitLabel="Ask"
              onInput={value => {
                question = value
              }}
              onSubmit={value => {
                question = value
                return readPhoto($, 'ask')
              }}
            />
          )}
        </Box>
      )
      const cell = (key: string, name: string, svg: string | null, isOn: boolean, press: () => Promise<void>) => (
        <Box key={`cell:${key}`} flexDirection="column" alignItems="center">
          {svg && Svg && <Svg source={svg} alt={name} width={CHIP} height={CHIP} />}
          <Button key={key} label={`${isOn ? '✓' : '＋'}${svg ? '' : ` ${name}`}`} plain dimColor={!isOn} onPress={press} />
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>Select a photo to attach it to your next message (✓ = attached).</Text>
          <Text bold>Inbox from iPhone</Text>
          {listed.length === 0 ? (
            <Text dimColor>Empty</Text>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {listed.map((item, i) =>
                cell(`inbox:${item.id}`, item.name, inboxChips[i] ?? null, tray.has(item.id), () => toggleInbox($, item)),
              )}
            </Box>
          )}
          <Text bold>Recent</Text>
          {recent.length === 0 ? (
            <Text dimColor>Empty</Text>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {recent.map((item, i) =>
                cell(`recent:${item.name}`, item.name, recentChips[i] ?? null, attached.has(`${p.snaps}/${item.name}`), () =>
                  toggleRecent($, item),
                ),
              )}
            </Box>
          )}
          <Button key="gallery:refresh" label="↻ Refresh" plain dimColor onPress={() => void refreshGallery($)} />
          <Text dimColor>Text and Ask use the newest attached photo, or the last shot if none is attached.</Text>
          {readRow}
          {text ? <Box key="read-text"><Text>{text}</Text></Box> : null}
          {noteRow}
        </Box>
      )
    }

    const phone = mode === 'iphone'
    const f = info?.framing
    // The stream's lens and zoom are newer than the last `state`.
    const zoomNow = frame.zoom ?? f?.zoom ?? 1
    const lensNow = frame.lens ?? f?.lens
    let video = null
    if (Image) {
      // Cells are about twice as tall as wide; leave rows for the controls below.
      const aspect = (frame.height ?? 9) / (frame.width ?? 16)
      const maxRows = clamp(e.props.scroll.bodyRows - CONTROL_ROWS, 4, 255)
      let columns = clamp(e.props.bodyColumns, 8, 255)
      let rows = Math.round((columns * aspect) / 2)
      if (rows > maxRows) {
        rows = maxRows
        columns = clamp(Math.round((rows * 2) / aspect), 8, 255)
      }
      rows = clamp(rows, 4, 255)
      const source =
        terminalBytes && frame.png && (await $.fs.exists(frame.png))
          ? { png: (await $.fs.read(frame.png, { as: 'bytes' })).base64 }
          : frame.png
            ? { file: frame.png, format: 'png' as const, generation: frame.seq }
            : null
      video = source ? <Image key="video" source={source} columns={columns} rows={rows} alt="SnapCam live video" /> : null
    } else if (Svg) {
      const svg = await videoSvg($, frame)
      // A fixed box: the surface needn't measure each new frame's markup.
      const width = Math.min(frame.width ?? LIVE_SIDE, e.props.bodyColumns * CELL_PX)
      const height = Math.round((width * (frame.height ?? 3)) / (frame.width ?? 4))
      video = svg ? <Svg source={svg} alt="SnapCam live video" width={width} height={height} /> : null
    }
    const waiting = frame.error ?? (frame.seq === 0 ? 'Connecting to the camera…' : 'Frame too large')
    // Errors show over a frozen last frame too.
    const problem = frame.error && video ? <Text color="red">⚠ {frame.error}</Text> : null
    const status = <Text dimColor>{framingLine(frame, info, mode, id)}</Text>
    if (e.props.placement === 'widget') {
      return <Box key="live" flexDirection="column">{video ?? <Text dimColor>{waiting}</Text>}{problem}</Box>
    }

    const lensRow = phone && info && info.lenses.length > 0 && (
      <Box key="lens-row" flexDirection="row" gap={1}>
        {info.lenses.map(lens => (
          <Button
            key={`lens:${lens.kind}`}
            label={times(lens.zoom)}
            variant={lensNow === lens.kind ? 'primary' : undefined}
            onPress={() => control($, ['frame', '--lens', lens.kind])}
          />
        ))}
        <Button key="zoom-" label="−" onPress={() => control($, ['frame', '--zoom', String(clamp(zoomNow / ZOOM_STEP, info.zoomMin, info.zoomMax))])} />
        <Text>{times(zoomNow)}</Text>
        <Button key="zoom+" label="+" onPress={() => control($, ['frame', '--zoom', String(clamp(zoomNow * ZOOM_STEP, info.zoomMin, info.zoomMax))])} />
      </Box>
    )
    const level = f?.light ?? 0
    const step = LIGHT_STEPS.reduce((best, l, i) => (Math.abs(l - level) < Math.abs((LIGHT_STEPS[best] ?? 0) - level) ? i : best), 0)
    const ev = f?.exposure ?? 0
    const evMin = info?.exposureMin ?? -2
    const evMax = info?.exposureMax ?? 2
    const setLight = async (to: number) => {
      if (to > 0) return control($, ['light', String(to)])
      await control($, ['light', 'off'])
      await control($, ['flash', 'off'])
    }
    const lightAt = (i: number) => () => setLight(LIGHT_STEPS[clamp(i, 0, LIGHT_STEPS.length - 1)] ?? 0)
    // The `flash` box keeps the contract's key: on the iPhone flash on is this light.
    const lightControls = info?.hasLight ? (
      <Box key="flash" flexDirection="row" gap={1}>
        <Button key="light-" label="💡−" onPress={lightAt(step - 1)} />
        <Button key="light" label={level > 0 ? `Light ${Math.round(level * 100)}%` : 'Off'} plain dimColor={level === 0} onPress={lightAt(0)} />
        <Button key="light+" label="💡+" onPress={lightAt(step + 1)} />
      </Box>
    ) : info?.flashModes.includes('on') ? (
      <Button
        key="flash"
        label={f?.flash === 'on' ? '⚡ Flash on' : '⚡ Flash off'}
        variant={f?.flash === 'on' ? 'primary' : undefined}
        onPress={() => control($, ['flash', f?.flash === 'on' ? 'off' : 'on'])}
      />
    ) : null
    const lightRow = phone && info && (
      <Box key="light-row" flexDirection="row" gap={1}>
        {lightControls}
        {info.exposureMin !== undefined && [
          <Button key="ev-" label="☀−" onPress={() => control($, ['exposure', String(clamp(ev - EV_STEP, evMin, evMax))])} />,
          <Button key="ev0" label={`${ev > 0 ? '+' : ''}${ev} EV`} plain dimColor={ev === 0} onPress={() => control($, ['exposure', '0'])} />,
          <Button key="ev+" label="☀+" onPress={() => control($, ['exposure', String(clamp(ev + EV_STEP, evMin, evMax))])} />,
        ]}
      </Box>
    )
    const sources = info?.sources ?? [{ mode: 'iphone' as SnapMode, name: 'iPhone' }]
    const current = sources.findIndex(s => s.mode === mode && (s.mode !== 'external' || !id || s.id === id))
    const sourceKey = (s: CameraInfo['sources'][number]) => (s.mode === 'external' ? `external:${s.id ?? ''}` : s.mode)
    const pickCamera = async (s: CameraInfo['sources'][number]) => {
      await update($, paneCamera, () => s.mode)
      await update($, paneSource, () => s.id ?? '')
      await tick($)
    }
    const shoot = async () => {
      const said = await snapToTray($, mode, '0', sourceOf(mode, id))
      await setNote($, 'shoot', said.startsWith('SnapCam') ? said : '')
      galleryAt = null
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box key="live" flexDirection="column">
          {video ?? <Text dimColor>{waiting}</Text>}
          {problem}
        </Box>
        <Box key="status">{status}</Box>
        <Box key="shoot-row" flexDirection="row" gap={1}>
          <Button key="shoot" label="📸 Shoot" variant="primary" onPress={shoot} />
        </Box>
        {sources.length > 1 && (
          <Box key="camera" flexDirection="row" gap={1} flexWrap="wrap">
            {sources.map((s, i) => (
              <Button
                key={`camera:${sourceKey(s)}`}
                label={s.mode === 'external' ? s.name : SHORT[s.mode]}
                variant={i === current ? 'primary' : undefined}
                dimColor={i !== current}
                onPress={() => pickCamera(s)}
              />
            ))}
          </Box>
        )}
        {lensRow}
        {lightRow}
        {/* A failed state poll and the stream's error tell one outage. */}
        {frame.error && noteFrom === 'state' ? null : noteRow}
      </Box>
    )
  })
}
