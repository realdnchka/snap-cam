import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InboxItem, SnapMode } from '../types'

const busy = atom({ plugin: 'snap-cam', key: 'busy' } as const, '')
const pending = atom({ plugin: 'snap-cam', key: 'pending' } as const, [] as string[])
const viewing = atom({ plugin: 'snap-cam', key: 'viewing' } as const, '')
// Phone-shutter photos in the Mac inbox, and ids the user dropped or already took.
const phoneTray = atom({ plugin: 'snap-cam', key: 'phoneTray' } as const, [] as InboxItem[])
const dismissed = atom({ plugin: 'snap-cam', key: 'dismissed' } as const, [] as string[])
const PANE = 'snap-preview'

const MODES: { mode: SnapMode; label: string }[] = [
  { mode: 'iphone', label: '📷 iPhone' },
  { mode: 'desk', label: '🗂 DeskView' },
]

type Flash = 'off' | 'on' | 'auto'
type Lens = 'ultraWide' | 'wide' | 'telephoto'
const FLASHES: Flash[] = ['off', 'on', 'auto']
const LENSES: Lens[] = ['ultraWide', 'wide', 'telephoto']
const TOOL = 'mcp__snap-cam__take_photo'
const TOOL_PREFIX = 'mcp__snap-cam__'
const POLL_MS = 3000
const RECENT_MAX = 5
const CLI_USAGE = 64
const PHONE_BUSY = 'phone'

// snapcam-cli from SnapCam for Mac (repo snapcam-app); 69 = no app or no paired phone.
const CLI_IN_APP = 'SnapCam.app/Contents/Helpers/snapcam-cli'
const CLI_TIMEOUT_S = 25
// User shots fire at once: they aim before pressing.
const MANUAL_COUNTDOWN_S = 0
const CLI_UNAVAILABLE = 69
// Paired phone around but not connected after the app's ~10 s wait; nothing was shot.
const CLI_OFFLINE = 75
const SIDE = 2400

// Old snaps lived in ~/Pictures/ClaudeSnaps; keep matching them.
const SNAP_PATH = /\/\S*\/Pictures\/(?:SnapCam\/)?ClaudeSnaps\/[\w.-]+\.jpg/g
const SNAP_LINE = /^📷 ([\w.-]+\.jpg)$/gm
const THUMB = 96

const BUILD = [
  'set -e',
  'mkdir -p "$APP/Contents/MacOS"',
  'swiftc -O -module-cache-path "$DIR/mc" -o "$APP/Contents/MacOS/SnapCam" "$SRC/SnapCam.swift"',
  'cp "$SRC/Info.plist" "$APP/Contents/Info.plist"',
  'codesign --force -s - "$APP"',
  'cp "$SRC/SnapCam.swift" "$DIR/built.swift"',
].join('\n')

type Paths = {
  dir: string; app: string; snaps: string; status: string; thumbs: string; staging: string; recent: string
  home: string
}

type Shot = { delay: string; flash?: Flash; lens?: Lens; zoom?: number }
type Taken = { path: string; note: string }
// Why the iPhone app path fell through to Continuity.
type Skipped = { reason: string; offline: boolean }
type InboxJson = {
  items?: {
    id: string; original: string; preview?: string; width?: number; height?: number
    format?: string; lens?: string; zoom?: number; phone?: string; takenAt?: string
  }[]
  remaining?: number
}
type RecentJson = {
  folder?: string
  items?: {
    original: string; preview?: string; width?: number; height?: number
    createdAt?: string; origin?: string; queued?: boolean
  }[]
}
type PeekJson = { preview?: string; width?: number; height?: number; lens?: string; zoom?: number; phone?: string }
type Cli = { exitCode: number; stdout: string; reason: string }
type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }
type PhoneJson = {
  original?: string; preview?: string; width?: number; height?: number; format?: string
  lens?: string; zoom?: number; phone?: string; ms?: number; error?: string
}

async function paths($: EngineInterface): Promise<Paths> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${home}/Library/Application Support/snap-cam`

  return {
    dir,
    app: `${dir}/SnapCam.app`,
    snaps: `${home}/Pictures/SnapCam/ClaudeSnaps`,
    status: `${dir}/last.status`,
    thumbs: `${dir}/thumbs`,
    staging: `${dir}/inbox-staging`,
    recent: `${dir}/recent-staging`,
    home,
  }
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// Rebuilds when the shipped source differs from the last build.
async function ensureApp($: EngineInterface, p: Paths): Promise<string | null> {
  const src = `${$.plugin.root}/helper`
  const fresh = await $.fs.read(`${src}/SnapCam.swift`)
  const built = (await $.fs.exists(`${p.dir}/built.swift`))
    ? await $.fs.read(`${p.dir}/built.swift`)
    : ''
  if (built === fresh && (await $.fs.exists(`${p.app}/Contents/MacOS/SnapCam`))) {
    return null
  }
  $.ui.toast('SnapCam: собираю helper (один раз, ~20 с)…')
  const run = await $.process.run(['/bin/sh', '-c', BUILD], {
    env: { APP: p.app, DIR: p.dir, SRC: src },
    timeoutMs: 300_000,
  })

  return run.exitCode === 0 ? null : `сборка не удалась: ${run.stderr.slice(-400)}`
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

async function runHelper($: EngineInterface, p: Paths, args: string[], extra: string[] = []): Promise<string> {
  await $.process.run(['rm', '-f', p.status])
  // By path: SnapCam for Mac has the same executable name.
  await $.process.run(['pkill', '-f', `${p.app}/Contents/MacOS/SnapCam`])
  await $.process.run(['open', '-W', '-n', p.app, '--args', ...args, p.status, ...extra], {
    timeoutMs: 600_000,
  })

  return (await $.fs.exists(p.status)) ? (await $.fs.read(p.status)).trim() : 'SnapCam не ответил'
}

async function makeThumb($: EngineInterface, p: Paths, photo: string, name = baseName(photo)): Promise<void> {
  await $.process.run(['mkdir', '-p', p.thumbs])
  await $.process.run(['sips', '-s', 'format', 'jpeg', '-Z', String(THUMB * 2), photo, '--out', `${p.thumbs}/${name}`])
}

async function findCli($: EngineInterface, p: Paths): Promise<string | null> {
  const own = await $.env.get('SNAPCAM_CLI')
  for (const path of [own, `${p.home}/Applications/${CLI_IN_APP}`, `/Applications/${CLI_IN_APP}`]) {
    if (path && (await $.fs.exists(path))) return path
  }

  return null
}

// The CLI prints one JSON line last.
function parseJson<T = PhoneJson>(text: string): Partial<T> {
  try {
    return (JSON.parse(text.trim().split('\n').pop() ?? '') ?? {}) as Partial<T>
  } catch {
    return {}
  }
}

async function runCli($: EngineInterface, cli: string, args: string[], timeoutS = CLI_TIMEOUT_S): Promise<Cli> {
  const run = await $.process.run([cli, ...args], { timeoutMs: timeoutS * 1000 })
  const reason =
    parseJson<{ error: string }>(run.stdout).error ??
    (run.stderr.trim().replace(/^snapcam-cli: /, '') || `snapcam-cli exit ${run.exitCode}`)

  return { exitCode: run.exitCode, stdout: run.stdout, reason }
}

function cliFailure(run: Cli): string {
  const why =
    run.exitCode === CLI_UNAVAILABLE ? 'SnapCam for Mac or the paired iPhone is not reachable'
    : run.exitCode === CLI_OFFLINE ? 'the paired iPhone did not connect in time'
    : run.exitCode === CLI_USAGE ? 'bad arguments'
    : 'the iPhone or the Mac app reported an error'

  return `${why}: ${run.reason}`
}

async function needCli($: EngineInterface, p: Paths): Promise<string> {
  const cli = await findCli($, p)
  if (!cli) throw new Error('SnapCam for Mac is not installed (snapcam-app: scripts/install-mac.sh)')

  return cli
}

// Stable chat-safe name: the Mac's originals have spaces.
const phoneName = (id: string) => `phone-${id.slice(0, 8).toLowerCase()}.jpg`

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

let polling = false

// Mirrors the Mac inbox into the tray; never launches the app.
async function pollInbox($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const p = await paths($)
    const cli = await findCli($, p)
    if (!cli) return
    const run = await $.process.run([cli, 'inbox', '--json', '--no-launch'], { timeoutMs: 10_000 })
    const listed = run.exitCode === 0 ? parseJson<InboxJson>(run.stdout).items : undefined
    if (!listed) return
    const ids = listed.map(item => item.id)
    await update($, dismissed, list => {
      const kept = list.filter(id => ids.includes(id))
      return sameIds(kept, list) ? list : kept
    })
    const shown = listed.map(item => ({ id: item.id, original: item.original, name: phoneName(item.id) }))
    for (const item of shown) {
      if (!(await $.fs.exists(`${p.thumbs}/${item.name}`))) await makeThumb($, p, item.original, item.name)
    }
    // Read late: a submit may have taken some while this ran.
    const gone = await read($, dismissed)
    const fresh = shown.filter(item => !gone.includes(item.id))
    await update($, phoneTray, list =>
      sameIds(list.map(item => item.id), fresh.map(item => item.id)) ? list : fresh,
    )
  } catch {
    // Next tick tries again.
  } finally {
    polling = false
  }
}

async function forget($: EngineInterface, ids: string[]): Promise<void> {
  await update($, dismissed, list => [...new Set([...list, ...ids])])
  await update($, phoneTray, list => list.filter(item => !ids.includes(item.id)))
}

// Moves CLI previews to ClaudeSnaps under chat-safe names.
async function placePreviews($: EngineInterface, p: Paths, items: NonNullable<InboxJson['items']>): Promise<Map<string, string>> {
  const placed = new Map<string, string>()
  for (const item of items) {
    if (!item.preview) continue
    const dest = `${p.snaps}/${phoneName(item.id)}`
    await $.process.run(['mv', '-f', item.preview, dest])
    if (await $.fs.exists(dest)) placed.set(item.id, dest)
  }

  return placed
}

// Takes the tray's phone photos from the inbox, so they are consumed once; a failed take keeps them.
async function takeTray($: EngineInterface, items: readonly InboxItem[]): Promise<string[]> {
  const ids = items.map(item => item.id)
  const p = await paths($)
  await $.process.run(['mkdir', '-p', p.snaps, p.staging])
  const cli = await findCli($, p)
  if (!cli) {
    $.ui.toast('SnapCam: фото с iPhone остались в лотке — приложение SnapCam для Mac не найдено')
    return []
  }
  const args = ['inbox', '--take', ...ids.flatMap(id => ['--id', id])]
  const run = await runCli($, cli, [...args, '--preview-dir', p.staging, '--preview-size', String(SIDE), '--json', '--no-launch'], 60)
  if (run.exitCode !== 0) {
    $.ui.toast(`SnapCam: фото с iPhone не забраны из входящих и остались в лотке (${run.reason})`)
    return []
  }
  await forget($, ids)
  const placed = await placePreviews($, p, parseJson<InboxJson>(run.stdout).items ?? [])
  const out: string[] = []
  for (const item of items) {
    const dest = placed.get(item.id) ?? `${p.snaps}/${item.name}`
    // Already taken elsewhere: convert the original here.
    if (!placed.has(item.id)) {
      await $.process.run(['sips', '-s', 'format', 'jpeg', '-Z', String(SIDE), item.original, '--out', dest])
    }
    if (await $.fs.exists(dest)) out.push(dest)
  }

  return out
}

const imageBlock = async ($: EngineInterface, path: string): Promise<Block> => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data: (await $.fs.read(path, { as: 'bytes' })).base64 },
})

// Chat-safe: originals are named `SnapCam 2026-… at ….heic`.
const recentName = (original: string) =>
  `recent-${baseName(original).replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-')}.jpg`

const ORIGINS: Record<string, string> = { phone: 'iPhone shutter', mac: 'shot from the Mac' }

// History, any origin; the tray and the inbox stay as they are.
async function recentPhotos($: EngineInterface, count: number): Promise<Block[]> {
  const p = await paths($)
  const cli = await needCli($, p)
  await $.process.run(['mkdir', '-p', p.snaps, p.recent])
  const args = ['recent', String(count), '--preview-dir', p.recent, '--preview-size', String(SIDE), '--json']
  const run = await runCli($, cli, args, 60)
  if (run.exitCode !== 0) throw new Error(cliFailure(run))
  const json = parseJson<RecentJson>(run.stdout)
  const items = json.items ?? []
  const folder = json.folder ?? 'the save folder'
  if (items.length === 0) return [{ type: 'text', text: `No photos in the SnapCam history yet (${folder}).` }]
  const blocks: Block[] = []
  const lines: string[] = []
  for (const [i, item] of items.entries()) {
    let path: string | undefined
    if (item.preview) {
      const dest = `${p.snaps}/${recentName(item.original)}`
      await $.process.run(['mv', '-f', item.preview, dest])
      if (await $.fs.exists(dest)) path = dest
    }
    const origin = ORIGINS[item.origin ?? ''] ?? 'origin unknown'
    const queued = item.queued ? '; also waiting in the tray above the prompt' : ''
    lines.push(
      `${i + 1}. ${path ?? '(no preview)'}: ${item.width ?? '?'}×${item.height ?? '?'}, ${origin}, ` +
        `saved ${item.createdAt ?? '?'}${queued}. Original: ${item.original}`,
    )
    if (path) blocks.push(await imageBlock($, path))
  }
  const text = `Last ${items.length} photo(s) from the SnapCam history (${folder}), newest first.\n${lines.join('\n')}`

  return [{ type: 'text', text }, ...blocks]
}

async function frame($: EngineInterface, lens?: Lens, zoom?: number, exposure?: number): Promise<Block[]> {
  const cli = await needCli($, await paths($))
  const moves = lens || zoom !== undefined
  let run: Cli | undefined
  if (moves || exposure === undefined) {
    const args = ['frame', ...(lens ? ['--lens', lens] : []), ...(zoom !== undefined ? ['--zoom', String(zoom)] : [])]
    run = await runCli($, cli, args, 30)
    if (run.exitCode !== 0) throw new Error(cliFailure(run))
  }
  if (exposure !== undefined) {
    run = await runCli($, cli, ['exposure', String(exposure)], 30)
    if (run.exitCode !== 0) throw new Error(cliFailure(run))
  }
  const changed = moves || exposure !== undefined ? 'Framing set' : 'Framing now'

  return [{ type: 'text', text: `${changed} (live; nothing shot): ${run?.stdout.trim() ?? ''}` }]
}

// 0 turns the light off; the phone clamps to its maximum.
async function light($: EngineInterface, level: number): Promise<Block[]> {
  const cli = await needCli($, await paths($))
  const run = await runCli($, cli, ['light', level > 0 ? String(level) : 'off'], 30)
  if (run.exitCode !== 0) throw new Error(cliFailure(run))

  return [{ type: 'text', text: `Light ${level > 0 ? 'set' : 'off'} (live; nothing shot): ${run.stdout.trim()}` }]
}

async function peek($: EngineInterface): Promise<Block[]> {
  const p = await paths($)
  const cli = await needCli($, p)
  const file = `${p.dir}/peek.jpg`
  const run = await runCli($, cli, ['peek', '--preview', file, '--json'], 30)
  if (run.exitCode !== 0) throw new Error(cliFailure(run))
  const json = parseJson<PeekJson>(run.stdout)
  const zoom = json.zoom !== undefined ? `, zoom ${times(json.zoom)}` : ''
  const text =
    `Viewfinder of ${json.phone ?? 'the iPhone'} now (not saved): ${json.width}×${json.height}, ` +
    `lens ${json.lens ?? 'auto'}${zoom}.`

  return [{ type: 'text', text }, await imageBlock($, file)]
}

async function cameraState($: EngineInterface): Promise<Block[]> {
  const cli = await needCli($, await paths($))
  const run = await runCli($, cli, ['state'], 30)
  if (run.exitCode !== 0) throw new Error(cliFailure(run))

  return [{ type: 'text', text: run.stdout.trim() }]
}

const times = (zoom: number) => `${Number(zoom.toFixed(1))}×`

// Shot through the SnapCam iPhone app, or why it fell through to Continuity.
async function shootPhone($: EngineInterface, p: Paths, out: string, shot: Shot): Promise<Taken | Skipped> {
  const cli = await findCli($, p)
  if (!cli) return { reason: 'SnapCam for Mac is not installed', offline: false }
  const delay = shot.delay === 'manual' ? MANUAL_COUNTDOWN_S : Number(shot.delay)
  const argv = [cli, 'capture', '--json', '--delay', String(delay), '--timeout', String(CLI_TIMEOUT_S)]
  argv.push('--preview', out, '--preview-size', String(SIDE))
  if (shot.lens) argv.push('--lens', shot.lens)
  if (shot.zoom !== undefined) argv.push('--zoom', String(shot.zoom))
  // Unset options use the Mac app's settings for the phone.
  if (shot.flash) argv.push('--flash', shot.flash)
  await update($, busy, () => PHONE_BUSY)
  const run = await $.process.run(argv, { timeoutMs: (CLI_TIMEOUT_S + delay + 30) * 1000 })
  const json = parseJson(run.stdout)
  const reason = json.error ?? (run.stderr.trim().replace(/^snapcam-cli: /, '') || `snapcam-cli exit ${run.exitCode}`)
  if (run.exitCode === CLI_UNAVAILABLE) return { reason, offline: false }
  if (run.exitCode === CLI_OFFLINE) return { reason, offline: true }
  if (run.exitCode !== 0 || !json.preview) throw new Error(reason)
  const note =
    `${json.phone ?? 'iPhone'} (SnapCam iPhone app): ${json.width}×${json.height} ${json.format ?? ''}, ` +
    `lens ${json.lens ?? 'auto'}${json.zoom !== undefined ? `, zoom ${times(json.zoom)}` : ''}, ` +
    `${json.ms ?? '?'} ms. Original: ${json.original}`

  return { path: json.preview, note }
}

function fallbackCause(skipped: Skipped): string {
  return skipped.offline
    ? `Приложение SnapCam на iPhone сопряжено, но не подключилось к Mac (${skipped.reason})`
    : `Приложение SnapCam на iPhone недоступно (${skipped.reason})`
}

// A numeric delay shoots by itself; throws with a reason.
async function shoot($: EngineInterface, mode: SnapMode, shot: Shot): Promise<Taken> {
  const p = await paths($)
  const out = `${p.snaps}/${mode}-${stamp(await $.clock.now())}.jpg`
  await $.process.run(['mkdir', '-p', p.snaps])
  await $.fs.write(`${p.dir}/last-mode.txt`, mode)
  let fellBack: Skipped | null = null
  if (mode === 'iphone') {
    const phone = await shootPhone($, p, out, shot)
    if ('path' in phone) {
      await makeThumb($, p, phone.path)
      return phone
    }
    fellBack = phone
    await update($, busy, () => mode)
  }
  const err = await ensureApp($, p)
  if (err) throw new Error(err)
  const zoom = shot.zoom !== undefined ? String(Math.min(Math.max(shot.zoom, 1), 3)) : undefined
  const extra = zoom ? [shot.flash ?? '', zoom] : shot.flash ? [shot.flash] : []
  const said = await runHelper($, p, [mode, out, shot.delay], extra)
  if (said !== out) {
    const cancelled = said === 'Отменено'
    throw new Error(fellBack && !cancelled ? `${fallbackCause(fellBack)}, а запасной путь через Continuity тоже не сработал: ${said}` : said)
  }
  await makeThumb($, p, out)
  const shotFile = `${p.dir}/last-shot.txt`
  const flashNote = mode === 'iphone' && (await $.fs.exists(shotFile)) ? `; ${await $.fs.read(shotFile)}` : ''
  const how = mode === 'desk' ? 'Desk View' : `Continuity Camera, because${fellBack?.offline ? ' the paired iPhone app did not reconnect' : ''}: ${fellBack?.reason ?? '?'}`
  const zoomNote = zoom ? `; crop zoom ${times(Number(zoom))}` : ''
  const lensNote = shot.lens ? '; lens ignored' : ''

  return { path: out, note: `${how}${zoomNote}${lensNote}${flashNote}` }
}

async function lastMode($: EngineInterface): Promise<SnapMode> {
  const file = `${(await paths($)).dir}/last-mode.txt`
  const saved = (await $.fs.exists(file)) ? (await $.fs.read(file)).trim() : ''

  return saved === 'desk' ? 'desk' : 'iphone'
}

async function snapToTray($: EngineInterface, mode: SnapMode, delay = 'manual'): Promise<string> {
  if ((await read($, busy)) !== '') return 'SnapCam уже снимает'
  await update($, busy, () => mode)
  try {
    const { path } = await shoot($, mode, { delay })
    await update($, pending, list => [...list, path])

    return `Фото прикреплено: ${baseName(path)}`
  } catch (error) {
    const msg = `SnapCam: ${error instanceof Error ? error.message : String(error)}`
    $.ui.toast(msg)

    return msg
  } finally {
    await update($, busy, () => '')
  }
}

// Builds a light preview with a size sidecar, small enough for an inline SVG.
async function openPreview($: EngineInterface, name: string, original?: string): Promise<void> {
  const p = await paths($)
  const src = original ?? `${p.snaps}/${name}`
  const file = `${p.dir}/previews/${name}`
  if (!(await $.fs.exists(`${file}.json`)) && (await $.fs.exists(src))) {
    await $.process.run(['mkdir', '-p', `${p.dir}/previews`])
    for (const side of [800, 600, 420]) {
      await $.process.run(['sips', '-Z', String(side), '-s', 'format', 'jpeg', '-s', 'formatOptions', '55', src, '--out', file])
      const { size } = await $.fs.stat(file)
      if (size < 90_000) break
    }
    const { stdout } = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])
    const w = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1] ?? 0)
    const h = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1] ?? 0)
    await $.fs.write(`${file}.json`, JSON.stringify({ w, h }))
  }
  await update($, viewing, () => name)
  await $.ui.open({ id: PANE, title: `📷 ${name}` })
}

async function previewSvg($: EngineInterface, name: string): Promise<string | null> {
  const file = `${(await paths($)).dir}/previews/${name}`
  if (!(await $.fs.exists(`${file}.json`)) || !(await $.fs.exists(file))) return null
  const { w, h } = JSON.parse(await $.fs.read(`${file}.json`)) as { w: number; h: number }
  const { base64 } = await $.fs.read(file, { as: 'bytes' })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image width="${w}" height="${h}" href="data:image/jpeg;base64,${base64}"/></svg>`
  )
}

// Square rounded chip with the photo cropped to fit.
async function chipSvg($: EngineInterface, name: string): Promise<string | null> {
  const p = await paths($)
  const file = `${p.thumbs}/${name}`
  if (!(await $.fs.exists(file))) return null
  const { base64 } = await $.fs.read(file, { as: 'bytes' })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB}" height="${THUMB}" viewBox="0 0 ${THUMB} ${THUMB}">` +
    `<defs><clipPath id="r"><rect width="${THUMB}" height="${THUMB}" rx="10"/></clipPath></defs>` +
    `<image clip-path="url(#r)" width="${THUMB}" height="${THUMB}" preserveAspectRatio="xMidYMid slice" ` +
    `href="data:image/jpeg;base64,${base64}"/></svg>`
  )
}

async function answer(work: Promise<Block[]>): Promise<{ result: Block[] } | { deny: string }> {
  try {
    return { result: await work }
  } catch (error) {
    return { deny: `SnapCam: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const hookFailed = (_$: unknown, _e: unknown, next: { error: { kind: string; message?: string } }) => ({
  deny: `SnapCam hook ${next.error.kind}: ${next.error.message ?? 'no message'}`,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'snap',
      description: 'Photo from iPhone or Desk View, attached to the next prompt',
      argumentHint: 'iphone | desk | list | caps | status | pair',
    })
    await $.tool.register({
      name: 'take_photo',
      description:
        "Take a photo with the user's iPhone or the Desk View camera on their Mac and get the image back. " +
        'iPhone: when the SnapCam app is open on a paired iPhone, it shoots full resolution there ' +
        '(real lens and zoom; the original stays on the Mac, you get a 2400 px copy). Otherwise it falls ' +
        'back to Continuity Camera: a preview window opens on the Mac and shoots by itself after a ~1.5 s ' +
        'warm-up plus delay_seconds (zoom becomes a 1–3× crop, lens is ignored; Esc cancels). ' +
        'Unless the phone sits on a stand, tell the user what to point it at and give them a few seconds. ' +
        'Shoot only when the user allows it; to check the framing first, use peek and frame, which shoot nothing. ' +
        'For a photo the user already took, use recent_photos.',
      inputSchema: {
        type: 'object',
        properties: {
          camera: { type: 'string', enum: ['iphone', 'desk'], description: 'iphone or desk (Desk View, top-down)' },
          delay_seconds: { type: 'number', minimum: 0, maximum: 60, description: 'Wait before the shot; 0 = right away' },
          flash: {
            type: 'string',
            enum: FLASHES,
            description: "iPhone only; on = the steady light (see light), auto = flash when dark; default: the user's choice",
          },
          lens: { type: 'string', enum: LENSES, description: 'iPhone app only; default: picked by zoom' },
          zoom: {
            type: 'number',
            minimum: 0.5,
            maximum: 25,
            description: 'Camera-app zoom (0.5, 1, 2, 5…), clamped to what the phone has; default: the lens own',
          },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'peek',
      description:
        "Look through the user's iPhone camera (SnapCam app open on a paired iPhone): one current viewfinder " +
        'frame (~1280 px, raw, not saved anywhere). Look first (peek), adjust (frame), peek again, and only ' +
        'then shoot with take_photo, and only when the user allows shooting.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'frame',
      description:
        "Change the live framing of the user's iPhone camera (SnapCam app) without shooting: lens, zoom and/or " +
        'exposure. The phone screen and the Mac follow. No inputs reads the current framing. Zoom wins over lens; a ' +
        "lens alone moves to that lens's own zoom; limits come from the phone (see camera_state). Then peek to check.",
      inputSchema: {
        type: 'object',
        properties: {
          lens: { type: 'string', enum: LENSES, description: 'Switch to this lens at its own zoom' },
          zoom: {
            type: 'number',
            minimum: 0.5,
            maximum: 25,
            description: 'Camera-app zoom (0.5, 1, 2, 5…), clamped to what the phone has',
          },
          exposure: {
            type: 'number',
            minimum: -100,
            maximum: 100,
            description: "Exposure bias in EV (-1 darker, +1 brighter, 0 = neutral), clamped to the phone's range",
          },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'light',
      description:
        "Turn the user's iPhone light (the steady torch, SnapCam app) on at a brightness, or off with 0. " +
        'Same as flash on; photos taken while it is lit fire no extra flash. It stays lit until turned off, so ' +
        'turn it off when done. The phone refuses while it is too hot (camera_state says "light off (hot)"). ' +
        'Shoots nothing; peek to check.',
      inputSchema: {
        type: 'object',
        properties: {
          level: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: "Brightness 0..1 of the phone's maximum; 0 = off",
          },
        },
        required: ['level'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'camera_state',
      description:
        "What the user's iPhone camera (SnapCam app) can do and how it is set now: lenses, zoom range, photo " +
        'sizes, flash modes, light and exposure ranges, the live lens/zoom/flash/light/exposure, and how many ' +
        'phone-shot photos wait in the tray above the prompt. ' +
        'Shoots nothing.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'recent_photos',
      description:
        'The last photos from the SnapCam history (the save folder of SnapCam for Mac), whatever took them: the ' +
        `iPhone app's own shutter, the Mac app or take_photo. Returns up to count (default 1, at most ${RECENT_MAX}), ` +
        'newest first, as images with their paths (2400 px upright copies; originals stay in the save folder, ' +
        'default ~/Pictures/SnapCam/Default). Use it when the user says they just took a photo. ' +
        'Only reads: photos waiting in the tray above the prompt stay there. Works without the phone.',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: RECENT_MAX,
            description: `How many, newest first; default 1, at most ${RECENT_MAX}`,
          },
        },
      },
      isDeferred: false,
    })
    if (e.isInteractive) {
      $.clock.every(POLL_MS, () => void pollInbox($))
      void pollInbox($)
    }

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    type Input = { camera?: string; delay_seconds?: number; flash?: string; lens?: string; zoom?: number }
    const input = e as unknown as Input
    const mode: SnapMode = input.camera === 'desk' ? 'desk' : 'iphone'
    const delay = String(Math.min(Math.max(Number(input.delay_seconds ?? 3) || 0, 0), 60))
    const flash = FLASHES.find(f => f === input.flash)
    const lens = LENSES.find(l => l.toLowerCase() === input.lens?.toLowerCase())
    const zoom = Number(input.zoom) > 0 ? Number(input.zoom) : undefined
    if ((await read($, busy)) !== '') return { deny: 'SnapCam is busy with another shot' }
    await update($, busy, () => mode)
    try {
      const taken = await shoot($, mode, { delay, flash, lens, zoom })
      const { base64 } = await $.fs.read(taken.path, { as: 'bytes' })

      return {
        result: [
          { type: 'text', text: `Photo saved: ${taken.path} (${taken.note})` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        ],
      }
    } catch (error) {
      return { deny: `SnapCam: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      await update($, busy, () => '')
    }
  }).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}peek` }, ($, e) => answer(peek($))).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}camera_state` }, ($, e) => answer(cameraState($))).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}frame` }, ($, e) => {
    const input = e as unknown as { lens?: string; zoom?: number; exposure?: number }
    const lens = LENSES.find(l => l.toLowerCase() === input.lens?.toLowerCase())
    const zoom = Number(input.zoom) > 0 ? Number(input.zoom) : undefined
    const bias = input.exposure === undefined ? NaN : Number(input.exposure)
    const exposure = Number.isFinite(bias) ? Math.min(Math.max(bias, -100), 100) : undefined

    return answer(frame($, lens, zoom, exposure))
  }).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}light` }, ($, e) => {
    const level = Number((e as unknown as { level?: number }).level)
    if (!Number.isFinite(level)) return { deny: 'SnapCam: light needs a level from 0 (off) to 1' }

    return answer(light($, Math.min(Math.max(level, 0), 1)))
  }).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}recent_photos` }, ($, e) => {
    const asked = Math.floor(Number((e as unknown as { count?: number }).count))

    return answer(recentPhotos($, asked >= 1 ? Math.min(asked, RECENT_MAX) : 1))
  }).catch(hookFailed)

  on('command.run', { command: 'snap' }, async ($, e) => {
    const arg = e.args.trim() || 'iphone'
    if (arg === 'caps' || arg === 'status' || arg === 'pair') {
      const cli = await findCli($, await paths($))
      if (!cli) return { text: 'SnapCam для Mac не установлен (snapcam-app: scripts/install-mac.sh)' }
      const run = await $.process.run([cli, arg], { timeoutMs: 60_000 })

      return { text: (run.stdout + run.stderr).trim() || `snapcam-cli: код ${run.exitCode}` }
    }
    if (arg === 'list') {
      const p = await paths($)
      const err = await ensureApp($, p)

      return { text: err ?? (await runHelper($, p, ['list', `${p.snaps}/list.jpg`, '0'])) }
    }
    const mode = (MODES.find(m => m.mode === arg)?.mode ?? 'iphone') as SnapMode

    return { text: await snapToTray($, mode), isTextDisplayOnly: true }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin?.kind === 'plugin') return next(e)
    const tray = await read($, pending)
    const fromPhone = await read($, phoneTray)
    const typed = e.text.match(SNAP_PATH) ?? []
    if (tray.length + fromPhone.length + typed.length === 0) return next(e)
    await update($, pending, () => [])
    const phoneShots = fromPhone.length > 0 ? await takeTray($, fromPhone) : []
    const attached = [...tray, ...phoneShots]
    const found = [...new Set([...attached, ...typed])]
    if (found.length === 0) return next(e)
    const lines = attached.map(path => `📷 ${baseName(path)}`).join('\n')
    const note =
      `The user attached camera photo(s): ${found.join(', ')}. ` +
      'Open each with the Read tool and look at it before answering.'

    return next({
      ...e,
      text: lines ? `${e.text}\n\n${lines}` : e.text,
      context: [...(e.context ?? []), note],
    })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const names = [...e.props.text.matchAll(SNAP_LINE)].map(m => m[1] ?? '')
    if (names.length === 0 || e.surface === 'terminal') return next(e)
    const text = e.props.text.replace(SNAP_LINE, '').trimEnd()
    const { Box, Svg, Button } = $.ui.resolve(e)
    const chips = await Promise.all(names.map(name => chipSvg($, name)))
    const row = await next({ ...e, props: { ...e.props, text } })

    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row" gap={1}>
          {names.map((name, i) => {
            const svg = chips[i]
            return svg ? (
              <Box key={name} flexDirection="column" alignItems="center">
                <Svg source={svg} alt={name} width={THUMB} height={THUMB} />
                <Button key={`zoom:${name}`} label="🔍" plain onPress={() => void openPreview($, name)} />
              </Box>
            ) : null
          })}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Svg } = $.ui.resolve(e)
    const name = await read($, viewing)
    const svg = name ? await previewSvg($, name) : null
    if (!svg) return <Text dimColor>Фото не найдено</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Svg source={svg} alt={name} />
        <Text dimColor>{name}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface === 'mobile') return next(e)
    const { Box, Button, Text, Svg } = $.ui.resolve(e)
    const now = await read($, busy)
    const shots = (await read($, pending)).map(path => ({ key: path, name: baseName(path), id: '', original: '' }))
    const fromPhone = (await read($, phoneTray)).map(item => ({ key: item.id, ...item }))
    const tray = [...shots, ...fromPhone]
    const canDraw = e.surface !== 'terminal'
    const chips = canDraw ? await Promise.all(tray.map(item => chipSvg($, item.name))) : []
    const drop = (item: (typeof tray)[number]) =>
      item.id ? forget($, [item.id]) : update($, pending, list => list.filter(one => one !== item.key))

    return (
      <Box flexDirection="column" gap={1}>
        {tray.length > 0 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            {tray.map((item, i) => {
              const svg = chips[i]
              return (
                <Box key={item.key} flexDirection="row" alignItems="center">
                  {svg ? (
                    <Svg source={svg} alt={item.name} width={THUMB / 2} height={THUMB / 2} />
                  ) : (
                    <Text>{item.id ? '📱' : '📷'} {item.name}</Text>
                  )}
                  <Button
                    key={`zoom:${item.key}`}
                    label="🔍"
                    plain
                    onPress={() => void openPreview($, item.name, item.original || undefined)}
                  />
                  <Button key={`x:${item.key}`} label="✕" plain onPress={() => void drop(item)} />
                </Box>
              )
            })}
          </Box>
        )}
        <Box flexDirection="row" gap={1} alignItems="center">
        {now === PHONE_BUSY ? (
          <Text dimColor>SnapCam: снимает iPhone…</Text>
        ) : now !== '' ? (
          <Text dimColor>SnapCam: смотри в окно превью…</Text>
        ) : (
          [
            ...MODES.map(m => (
              <Button key={m.mode} label={m.label} onPress={() => void snapToTray($, m.mode)} />
            )),
            <Button
              key="fast"
              label="⚡ Fast Capture"
              onPress={() => void lastMode($).then(mode => snapToTray($, mode, '0'))}
            />,
          ]
        )}
        </Box>
      </Box>
    )
  })
}
