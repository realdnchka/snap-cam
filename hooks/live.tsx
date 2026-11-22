import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CameraInfo, Framing, InboxItem, LiveFrame, PaneTab, RecentItem, SnapMode } from '../types'
import {
  CLI_USAGE, SIDE, SOURCES, baseName, chipSvg, cliFailure, findCli, makeThumb, parseJson, paths, runCli, snapToTray, times,
} from './cli'

const cameraInfo = atom({ plugin: 'snap-cam', key: 'cameraInfo' } as const, null as CameraInfo | null)
const dismissed = atom({ plugin: 'snap-cam', key: 'dismissed' } as const, [] as string[])
const gallery = atom({ plugin: 'snap-cam', key: 'gallery' } as const, [] as RecentItem[])
const inbox = atom({ plugin: 'snap-cam', key: 'inbox' } as const, [] as InboxItem[])
const liveFrame = atom({ plugin: 'snap-cam', key: 'liveFrame' } as const, { seq: 0 } as LiveFrame)
const paneCamera = atom({ plugin: 'snap-cam', key: 'paneCamera' } as const, 'iphone' as SnapMode)
const paneNote = atom({ plugin: 'snap-cam', key: 'paneNote' } as const, '')
const paneTab = atom({ plugin: 'snap-cam', key: 'paneTab' } as const, 'camera' as PaneTab)
const pending = atom({ plugin: 'snap-cam', key: 'pending' } as const, [] as string[])
const phoneTray = atom({ plugin: 'snap-cam', key: 'phoneTray' } as const, [] as InboxItem[])

export const LIVE_PANE = 'snap-live'
const TITLE = '📷 SnapCam'
const FPS = 5
const LIVE_SIDE = 640
// Svg.source limit; a bigger frame is skipped.
const SVG_MAX = 131_072
const TICK_MS = 1000
// Tabs, status, shoot, lens and light rows under the terminal video.
const CONTROL_ROWS = 10
const GALLERY_COUNT = 8
const GALLERY_EVERY_MS = 15_000
const ZOOM_STEP = 1.4
const EV_STEP = 0.5
const LIGHT_LEVELS = [0, 0.3, 0.6, 1]
const FLASH_ORDER = ['off', 'auto', 'on']
const CHIP = 72
const LENS_LABEL: Record<string, string> = { ultraWide: 'ultra', wide: 'wide', telephoto: 'tele' }
const SHORT: Record<SnapMode, string> = { iphone: 'iPhone', continuity: 'Continuity', desk: 'Desk View', mac: 'камера Mac' }
const short = (mode: SnapMode) => SHORT[mode]
const SOURCE_MODES: Record<string, SnapMode> = { phone: 'iphone', continuity: 'continuity', deskView: 'desk', builtIn: 'mac' }

type LiveLine = LiveFrame & { error?: string }
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
  sources?: { kind: string; name: string }[]
}
type RecentJson = { items?: { original: string }[] }

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

// Chat-safe and stable per original, so a click finds its copy again.
export const galleryName = (original: string) =>
  `recent-${baseName(original).replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-')}.jpg`

type Run = {
  stream: AsyncGenerator<unknown, unknown>
  mode: SnapMode
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

function stopLive(): void {
  startGen += 1
  if (!run) return
  run.stopped = true
  void run.stream.return(undefined).catch(() => {})
  run = null
}

async function startLive($: EngineInterface, mode: SnapMode, surfaces: readonly string[]): Promise<void> {
  const gen = startGen
  const p = await paths($)
  const cli = await findCli($, p)
  if (!cli) {
    await ended($, 'SnapCam для Mac не установлен')
    return
  }
  if (gen !== startGen) return
  const blit = surfaces.includes('terminal')
  const source = mode === 'iphone' ? [] : ['--source', SOURCES[mode].source]
  const argv = [cli, 'live', '--preview-dir', `${p.dir}/live/${LIVE_ID}`, '--preview-size', String(LIVE_SIDE)]
  argv.push('--fps', String(FPS), '--json', ...(blit ? ['--png'] : []), ...source)
  const stream = $.process.spawn({ argv })
  const me: Run = { stream, mode, stopped: false, everyFrame: surfaces.some(s => s !== 'terminal'), blit, bytes: false, denials: 0 }
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
        const why =
          code === CLI_USAGE ? 'Обнови SnapCam для Mac: этот snapcam-cli не умеет live'
          : stderr.trim().split('\n').pop() || `snapcam-cli live: код ${code}`
        await ended($, why)
      }
    } catch (error) {
      // Also an unload: $ may be gone, so nothing may throw from here.
      if (!me.stopped) await ended($, String(error)).catch(() => {})
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
    await update($, liveFrame, f => (f.error === line.error ? f : { ...f, error: line.error }))
    return
  }
  if (!line.preview || !line.seq) return
  const next: LiveFrame = {
    seq: line.seq, preview: line.preview, png: line.png, width: line.width, height: line.height,
    lens: line.lens, zoom: line.zoom, phone: line.phone,
  }
  if (me.blit && line.png) void blitFrame($, me, line.png, line.seq)
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
    const shown = !!pane && pane.isShown && pane.isPlaced
    const tab = await read($, paneTab)
    const mode = await read($, paneCamera)
    const surfaces = await $.session.surfaces()
    // A surface came or went: restart with its flags.
    // Only --png needs a new child; the redraw policy changes in place.
    if (run) run.everyFrame = surfaces.some(s => s !== 'terminal')
    const changed = run && run.blit !== surfaces.includes('terminal') && run.denials < MAX_DENIALS
    if (run && (!shown || tab !== 'camera' || run.mode !== mode || changed)) stopLive()
    const now = await $.clock.now()
    if (shown && tab === 'camera' && !infoBusy && (infoAt === null || now - infoAt > INFO_EVERY_MS)) {
      infoAt = now
      void refreshInfo($).catch(() => {})
    }
    if (shown && tab === 'camera' && !run && now >= retryAt) await startLive($, mode, surfaces)
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
    if (mode && !sources.some(s => s.mode === mode)) sources.push({ mode, name: one.name })
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
      await setNote($, 'state', cliFailure(res))
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
    await setNote($, 'recent', cliFailure(res))
    return
  }
  await setNote($, 'recent', '')
  const items: RecentItem[] = (parseJson<RecentJson>(res.stdout).items ?? []).map(item => ({
    original: item.original,
    name: galleryName(item.original),
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
    await setNote($, 'control', cliFailure(res))
    return
  }
  const framing = parseJson<{ framing: Framing }>(res.stdout).framing
  await setNote($, 'control', '')
  if (framing) await update($, cameraInfo, info => (info ? { ...info, framing } : info))
}

async function toggleRecent($: EngineInterface, item: RecentItem): Promise<void> {
  const p = await paths($)
  const dest = `${p.snaps}/${item.name}`
  if ((await read($, pending)).includes(dest)) {
    await update($, pending, list => list.filter(one => one !== dest))
    return
  }
  await $.process.run(['mkdir', '-p', p.snaps])
  await $.process.run(['sips', '-s', 'format', 'jpeg', '-Z', String(SIDE), item.original, '--out', dest])
  if (!(await $.fs.exists(dest))) {
    await setNote($, 'control', `Не удалось прочитать ${baseName(item.original)}`)
    return
  }
  await update($, pending, list => (list.includes(dest) ? list : [...list, dest]))
}

// A tray photo off goes to `dismissed`; back on leaves it.
async function toggleInbox($: EngineInterface, item: InboxItem): Promise<void> {
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
  const opened = await $.ui.open({ id: LIVE_PANE, title: TITLE })
  infoAt = null
  launchNext = true
  void tick($)

  return opened.isPlaced
}

async function videoSvg($: EngineInterface, frame: LiveFrame): Promise<string | null> {
  if (!frame.preview || !frame.width || !frame.height || !(await $.fs.exists(frame.preview))) return null
  const { base64 } = await $.fs.read(frame.preview, { as: 'bytes' })
  const { width: w, height: h } = frame
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image width="${w}" height="${h}" href="data:image/jpeg;base64,${base64}"/></svg>`

  if (svg.length <= SVG_MAX) lastSvg = svg

  return lastSvg
}

function framingLine(frame: LiveFrame, info: CameraInfo | null, mode: SnapMode): string {
  const f = info?.framing
  const name = frame.phone ?? (mode === 'iphone' ? info?.phone : undefined) ?? short(mode)
  const parts = [name]
  if (mode === 'iphone' && f) {
    parts.push(`${LENS_LABEL[f.lens ?? ''] ?? f.lens ?? ''} ${times(frame.zoom ?? f.zoom)}`.trim())
    parts.push(`вспышка ${f.flash}`)
    if (f.light > 0) parts.push(`свет ${Math.round(f.light * 100)}%`)
    if (f.exposure !== 0) parts.push(`${f.exposure > 0 ? '+' : ''}${f.exposure} EV`)
  }

  return parts.join(' · ')
}

// Called from session.start in interactive sessions.
export function startLiveClock($: EngineInterface): void {
  $.clock.every(TICK_MS, () => void tick($))
}

export function registerLive(on: On): void {
  on('ui.close', async ($, e, next) => {
    if (e.id === LIVE_PANE) {
      stopLive()
      infoAt = null
      lastSvg = null
      const p = await paths($)
      void $.process.run(['rm', '-rf', `${p.dir}/live/${LIVE_ID}`]).catch(() => {})
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: LIVE_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const tab = await read($, paneTab)
    const mode = await read($, paneCamera)
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
        <Button key="tab:camera" label="🎥 Камера" variant={tab === 'camera' ? 'primary' : undefined} onPress={setTab('camera')} />
        <Button key="tab:gallery" label="🖼 Галерея" variant={tab === 'gallery' ? 'primary' : undefined} onPress={setTab('gallery')} />
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
      const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
      const cell = (key: string, name: string, svg: string | null, isOn: boolean, press: () => Promise<void>) => (
        <Box key={`cell:${key}`} flexDirection="column" alignItems="center">
          {svg && Svg && <Svg source={svg} alt={name} width={CHIP} height={CHIP} />}
          <Button key={key} label={`${isOn ? '✓' : '＋'}${svg ? '' : ` ${name}`}`} plain dimColor={!isOn} onPress={press} />
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>Нажми на фото, чтобы прикрепить к следующему сообщению (✓ — прикреплено).</Text>
          <Text bold>Входящие с iPhone</Text>
          {listed.length === 0 ? (
            <Text dimColor>Пусто</Text>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {listed.map((item, i) =>
                cell(`inbox:${item.id}`, item.name, inboxChips[i] ?? null, tray.has(item.id), () => toggleInbox($, item)),
              )}
            </Box>
          )}
          <Text bold>Недавние</Text>
          {recent.length === 0 ? (
            <Text dimColor>Пусто</Text>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {recent.map((item, i) =>
                cell(`recent:${item.name}`, item.name, recentChips[i] ?? null, attached.has(`${p.snaps}/${item.name}`), () =>
                  toggleRecent($, item),
                ),
              )}
            </Box>
          )}
          <Button key="gallery:refresh" label="↻ Обновить" plain dimColor onPress={() => void refreshGallery($)} />
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
    if (e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
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
      video = source ? <Image key="video" source={source} columns={columns} rows={rows} alt="Живое видео SnapCam" /> : null
    } else {
      const { Svg } = $.ui.resolve(e)
      const svg = await videoSvg($, frame)
      video = svg ? <Svg source={svg} alt="Живое видео SnapCam" /> : null
    }
    const waiting = frame.error ?? (frame.seq === 0 ? 'Подключаюсь к камере…' : 'Кадр слишком большой')
    // Errors show over a frozen last frame too.
    const problem = frame.error && video ? <Text color="red">⚠ {frame.error}</Text> : null
    const status = <Text dimColor>{framingLine(frame, info, mode)}</Text>
    if (e.props.placement === 'widget') {
      return <Box key="live" flexDirection="column">{video ?? <Text dimColor>{waiting}</Text>}{problem}</Box>
    }

    const lensRow = phone && info && info.lenses.length > 0 && (
      <Box flexDirection="row" gap={1}>
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
    const flashModes = FLASH_ORDER.filter(m => info?.flashModes.includes(m))
    const nextFlash = flashModes[(flashModes.indexOf(f?.flash ?? 'off') + 1) % Math.max(flashModes.length, 1)] ?? 'off'
    const level = f?.light ?? 0
    const nextLight = LIGHT_LEVELS.find(l => l > level + 0.01) ?? 0
    const ev = f?.exposure ?? 0
    const evMin = info?.exposureMin ?? -2
    const evMax = info?.exposureMax ?? 2
    const lightRow = phone && info && (
      <Box flexDirection="row" gap={1}>
        {flashModes.length > 1 && (
          <Button key="flash" label={`⚡ ${f?.flash ?? 'off'}`} onPress={() => control($, ['flash', nextFlash])} />
        )}
        {info.hasLight && (
          <Button
            key="light"
            label={level > 0 ? `💡 ${Math.round(level * 100)}%` : '💡 выкл'}
            onPress={() => control($, ['light', nextLight > 0 ? String(nextLight) : 'off'])}
          />
        )}
        {info.exposureMin !== undefined && [
          <Button key="ev-" label="☀−" onPress={() => control($, ['exposure', String(clamp(ev - EV_STEP, evMin, evMax))])} />,
          <Button key="ev0" label={`${ev > 0 ? '+' : ''}${ev} EV`} plain dimColor={ev === 0} onPress={() => control($, ['exposure', '0'])} />,
          <Button key="ev+" label="☀+" onPress={() => control($, ['exposure', String(clamp(ev + EV_STEP, evMin, evMax))])} />,
        ]}
      </Box>
    )
    const sources = info?.sources ?? [{ mode: 'iphone' as SnapMode, name: 'iPhone' }]
    const nextSource = sources[(sources.findIndex(s => s.mode === mode) + 1) % sources.length]?.mode ?? 'iphone'
    const shoot = async () => {
      const said = await snapToTray($, mode, '0')
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
        <Box flexDirection="row" gap={1}>
          <Button key="shoot" label="📸 Снять" variant="primary" onPress={shoot} />
          {sources.length > 1 && (
            <Button
              key="camera"
              label={`↻ ${short(nextSource)}`}
              dimColor
              onPress={async () => {
                await update($, paneCamera, () => nextSource)
                await tick($)
              }}
            />
          )}
        </Box>
        {lensRow}
        {lightRow}
        {noteRow}
      </Box>
    )
  })
}
