import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InboxItem, SnapMode } from '../types'
import {
  CAMERAS, CLI_UNAVAILABLE, FLASHES, INSTALL, LENSES, MAC_TIMEOUT_S, READ_TIMEOUT_S, RECENT_MAX, SHORT, SIDE, SOURCES, THUMB,
  baseName, chipSvg, cliFailure, describeText, findCli, lastMode, makeThumb, needCli, paneFailure, parseJson, paths, photoArgs,
  recentName, runCli, shoot, snapToTray, stamp, times,
} from './cli'
import type { Cli, Lens, Paths, PhotoText } from './cli'
import { LIVE_PANE, openLive, registerLive, startLiveClock } from './live'

const busy = atom({ plugin: 'snap-cam', key: 'busy' } as const, '')
const dismissed = atom({ plugin: 'snap-cam', key: 'dismissed' } as const, [] as string[])
const inbox = atom({ plugin: 'snap-cam', key: 'inbox' } as const, [] as InboxItem[])
const pending = atom({ plugin: 'snap-cam', key: 'pending' } as const, [] as string[])
const phoneTray = atom({ plugin: 'snap-cam', key: 'phoneTray' } as const, [] as InboxItem[])
const viewing = atom({ plugin: 'snap-cam', key: 'viewing' } as const, '')

const PANE = 'snap-preview'

// Band buttons; take_photo also takes continuity and mac.
const MODES: { mode: SnapMode; label: string }[] = [
  { mode: 'iphone', label: '📷 iPhone' },
  { mode: 'desk', label: '🗂 DeskView' },
]


const TOOL = 'mcp__snap-cam__take_photo'
const TOOL_PREFIX = 'mcp__snap-cam__'
const POLL_MS = 3000
// Backoff cap while the Mac app is down: 10 ticks = 30 s.
const POLL_MAX_TICKS = 10

// Old snaps lived in ~/Pictures/ClaudeSnaps; keep matching them.
const SNAP_PATH = /\/\S*\/Pictures\/(?:SnapCam\/)?ClaudeSnaps\/[\w.-]+\.jpg/g
const SNAP_LINE = /^📷 ([\w.-]+\.jpg)$/gm

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
    createdAt?: string; origin?: string; queued?: boolean; error?: string
  }[]
}
type PeekJson = { preview?: string; width?: number; height?: number; lens?: string; zoom?: number; phone?: string }
type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }

// Stable chat-safe name: the Mac's originals have spaces.
const phoneName = (id: string) => `phone-${id.slice(0, 8).toLowerCase()}.jpg`

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

let polling = false
// Consecutive exit-69 polls and ticks left to skip because of them.
let misses = 0
let skipTicks = 0
// Phone ids a submit is taking right now.
const taking = new Set<string>()

function resetBackoff(): void {
  misses = 0
  skipTicks = 0
}

function pollTick($: EngineInterface): void {
  if (skipTicks > 0) {
    skipTicks -= 1
    return
  }
  void pollInbox($)
}

// Mirrors the Mac inbox into the tray; never launches the app.
async function pollInbox($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const p = await paths($)
    const cli = await findCli($, p)
    if (!cli) return
    const run = await $.process.run([cli, 'inbox', '--json', '--no-launch'], { timeoutMs: 10_000 })
    if (run.exitCode === CLI_UNAVAILABLE) {
      misses += 1
      skipTicks = Math.min(2 ** misses, POLL_MAX_TICKS) - 1
      return
    }
    if (run.exitCode === 0) resetBackoff()
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
    await update($, inbox, list => (sameIds(list.map(item => item.id), ids) ? list : shown))
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
    $.ui.toast(`SnapCam: фото с iPhone не забраны из входящих и остались в лотке. ${paneFailure(run)}`)
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

let recentRuns = 0

const ORIGINS: Record<string, string> = { phone: 'iPhone shutter', mac: 'shot from the Mac' }

// History, any origin; the tray and the inbox stay as they are.
async function recentPhotos($: EngineInterface, count: number): Promise<Block[]> {
  const p = await paths($)
  const cli = await needCli($, p)
  // Own staging folder per call, removed after.
  recentRuns += 1
  const staging = `${p.recent}/${stamp(await $.clock.now())}-${recentRuns}`
  await $.process.run(['mkdir', '-p', p.snaps, staging])
  try {
    const args = ['recent', String(count), '--preview-dir', staging, '--preview-size', String(SIDE), '--json']
    const run = await runCli($, cli, args, 60)
    if (run.exitCode !== 0) throw new Error(cliFailure(run))
    const json = parseJson<RecentJson>(run.stdout)
    const items = json.items ?? []
    const folder = json.folder ?? 'the save folder'
    if (items.length === 0) return [{ type: 'text', text: `No photos in the SnapCam history yet (${folder}).` }]
    const blocks: Block[] = []
    const lines: string[] = []
    const failed: string[] = []
    for (const [i, item] of items.entries()) {
      let path: string | undefined
      if (item.preview) {
        const dest = `${p.snaps}/${recentName(item.original)}`
        await $.process.run(['mv', '-f', item.preview, dest])
        if (await $.fs.exists(dest)) path = dest
      }
      if (!path) failed.push(`${item.original}: ${item.error ?? 'no preview'}`)
      const origin = ORIGINS[item.origin ?? ''] ?? 'origin unknown'
      const queued = item.queued ? '; also waiting in the tray above the prompt' : ''
      const shown = path ? `${path}: ${item.width ?? '?'}×${item.height ?? '?'}` : `(no preview: ${item.error ?? 'unknown'})`
      lines.push(`${i + 1}. ${shown}, ${origin}, saved ${item.createdAt ?? '?'}${queued}. Original: ${item.original}`)
      if (path) blocks.push(await imageBlock($, path))
    }
    const failures = failed.length > 0 ? `\nCould not read ${failed.length}:\n${failed.join('\n')}` : ''
    const text =
      `Last ${items.length} photo(s) from the SnapCam history (${folder}), newest first.\n${lines.join('\n')}${failures}`

    return [{ type: 'text', text }, ...blocks]
  } finally {
    await $.process.run(['rm', '-rf', staging])
  }
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

async function peek($: EngineInterface, mode: SnapMode): Promise<Block[]> {
  const p = await paths($)
  const cli = await needCli($, p)
  const file = `${p.dir}/peek.jpg`
  // No --source for the phone: older Mac apps still take that call.
  const source = mode === 'iphone' ? [] : ['--source', SOURCES[mode].source]
  const run = await runCli($, cli, ['peek', '--preview', file, '--json', ...source], mode === 'iphone' ? 30 : MAC_TIMEOUT_S + 5)
  if (run.exitCode !== 0) throw new Error(cliFailure(run))
  const json = parseJson<PeekJson>(run.stdout)
  const zoom = json.zoom !== undefined ? `, zoom ${times(json.zoom)}` : ''
  const lens = mode === 'iphone' ? `, lens ${json.lens ?? 'auto'}` : ' (crop zoom)'
  const text =
    `Viewfinder of ${json.phone ?? SOURCES[mode].title} now (not saved): ${json.width}×${json.height}` +
    `${lens}${zoom}.`

  return [{ type: 'text', text }, await imageBlock($, file)]
}

async function cameraState($: EngineInterface): Promise<Block[]> {
  const cli = await needCli($, await paths($))
  const run = await runCli($, cli, ['state'], 30)
  if (run.exitCode !== 0) throw new Error(cliFailure(run))

  return [{ type: 'text', text: run.stdout.trim() }]
}

async function readText($: EngineInterface, input: { path?: unknown; recent?: unknown }): Promise<Block[]> {
  const cli = await needCli($, await paths($))
  const run = await runCli($, cli, ['ocr', ...photoArgs(input), '--json'], READ_TIMEOUT_S)
  if (run.exitCode !== 0) throw new Error(run.reason)
  const photos = parseJson<{ photos: PhotoText[] }>(run.stdout).photos ?? []
  const note = 'On-device OCR (Vision, en+ru); [area] is the rough place in the photo; may contain mistakes.'

  return [{ type: 'text', text: `${note}\n\n${describeText(photos)}` }]
}

async function askPhoto(
  $: EngineInterface,
  input: { question?: unknown; path?: unknown; recent?: unknown },
): Promise<Block[]> {
  const cli = await needCli($, await paths($))
  const question = typeof input.question === 'string' ? input.question.trim() : ''
  const argv = ['ask', ...photoArgs(input), '--json']
  if (question) argv.push('--question', question)
  const run = await runCli($, cli, argv, READ_TIMEOUT_S)
  if (run.exitCode !== 0) throw new Error(run.reason)
  const json = parseJson<{ answer: string; photos: string[] }>(run.stdout)

  return [
    {
      type: 'text',
      text: `${json.answer ?? ''}\n\n(on-device Apple model, from the OCR text of ${(json.photos ?? []).join(', ')})`,
    },
  ]
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
  registerLive(on)
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'snap',
      description: 'Photo from iPhone, Desk View or a Mac camera, attached to the next prompt',
      argumentHint: 'iphone | continuity | desk | mac | pane | list | caps | status | pair',
    })
    await $.tool.register({
      name: 'take_photo',
      description:
        "Take a photo through SnapCam for Mac and get the image back. camera: iphone (default) = the SnapCam " +
        'app on a paired iPhone, full resolution with real lenses and zoom; continuity = the iPhone as ' +
        "Continuity Camera; desk = Desk View (top-down); mac = the Mac's built-in camera. Mac cameras " +
        '(continuity, desk, mac) give a plain photo: zoom is a 1–3× crop, no lens, flash only where the ' +
        'device has one. The original stays on the Mac, you get a 2400 px copy. ' +
        'Unless the camera sits on a stand, tell the user what to point it at and give them a few seconds. ' +
        'Shoot only when the user allows it; to check the framing first, use peek and frame, which shoot nothing. ' +
        'For a photo the user already took, use recent_photos.',
      inputSchema: {
        type: 'object',
        properties: {
          camera: {
            type: 'string',
            enum: CAMERAS,
            description: 'iphone (SnapCam app, default), continuity, desk (Desk View, top-down) or mac (built-in)',
          },
          delay_seconds: { type: 'number', minimum: 0, maximum: 60, description: 'Wait before the shot; 0 = right away' },
          flash: {
            type: 'string',
            enum: FLASHES,
            description:
              "iPhone app: on = the steady light (see light); Mac cameras: flash if any; auto = flash when dark; default: the user's choice",
          },
          lens: { type: 'string', enum: LENSES, description: 'iPhone app only; default: picked by zoom' },
          zoom: {
            type: 'number',
            minimum: 0.5,
            maximum: 25,
            description:
              'Camera-app zoom (0.5, 1, 2, 5…), clamped to what the camera has (Mac cameras: 1–3× crop); default: the lens own',
          },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'peek',
      description:
        "Look through one of the user's cameras: one current viewfinder frame (~1280 px, raw, not saved " +
        'anywhere). camera as in take_photo (default iphone). Look first (peek), adjust (frame, iPhone ' +
        'app only), peek again, and only then shoot with take_photo, and only when the user allows shooting.',
      inputSchema: {
        type: 'object',
        properties: {
          camera: { type: 'string', enum: CAMERAS, description: 'iphone (default), continuity, desk or mac' },
        },
      },
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
        'level is absolute (0..1 of the maximum), not a step from the current one; the phone clamps it. ' +
        'Same as flash on; photos taken while it is lit fire no extra flash. It stays lit until turned off, so ' +
        'turn it off when done. The phone refuses while it is too hot (camera_state says "light off (hot)") ' +
        'or while the iPhone app is in the background ("light off (iPhone app in background)"). ' +
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
        "The cameras SnapCam can shoot with (sources: the iPhone app and the Mac's cameras, * = chosen in " +
        "the Mac app), what the iPhone camera (SnapCam app) can do and how it is set now: lenses, zoom range, " +
        'photo sizes, flash modes, light and exposure ranges, the live lens/zoom/flash/light/exposure, and how ' +
        'many phone-shot photos wait in the tray above the prompt. ' +
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
    const photoInputs = {
      path: { type: 'string', description: 'A photo file; default: the newest SnapCam photo' },
      recent: {
        type: 'integer',
        minimum: 1,
        maximum: RECENT_MAX,
        description: `Without path: the newest N SnapCam photos (default 1, at most ${RECENT_MAX})`,
      },
    }
    await $.tool.register({
      name: 'read_text',
      description:
        'Read the text in a SnapCam photo with on-device OCR on the Mac (Vision, English and Russian). Returns ' +
        'paragraphs in reading order, each with its rough place ([top left], [center]…). Works on saved photos ' +
        '(originals), never on live frames; no phone needed. Cheaper and more exact than reading the image yourself ' +
        'for long text.',
      inputSchema: { type: 'object', properties: photoInputs },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'ask_photo',
      description:
        "Ask the Mac's on-device Apple model (Apple Intelligence, local only) a question about the text in a " +
        'SnapCam photo; without a question it summarizes. It sees only the OCR text, not the image. Fails with a ' +
        'clear reason when Apple Intelligence is off or unavailable; then use read_text and answer yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What to ask about the text; default: summarize' },
          ...photoInputs,
        },
      },
      isDeferred: false,
    })
    if (e.isInteractive) {
      $.clock.every(POLL_MS, () => pollTick($))
      void pollInbox($)
      startLiveClock($)
    }

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    type Input = { camera?: string; delay_seconds?: number; flash?: string; lens?: string; zoom?: number }
    const input = e as unknown as Input
    const mode: SnapMode = CAMERAS.find(c => c === input.camera?.toLowerCase()) ?? 'iphone'
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
  on('tool.call', { tool: `${TOOL_PREFIX}peek` }, ($, e) => {
    const camera = (e as unknown as { camera?: string }).camera?.toLowerCase()

    return answer(peek($, CAMERAS.find(c => c === camera) ?? 'iphone'))
  }).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}camera_state` }, ($, e) => answer(cameraState($))).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}frame` }, ($, e) => {
    const input = e as unknown as { lens?: string; zoom?: number; exposure?: number }
    const lens = LENSES.find(l => l.toLowerCase() === input.lens?.toLowerCase())
    const zoom = Number(input.zoom) > 0 ? Number(input.zoom) : undefined
    // null from the model means unset, not 0 EV.
    const bias = input.exposure == null ? NaN : Number(input.exposure)
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

  on('tool.call', { tool: `${TOOL_PREFIX}read_text` }, ($, e) =>
    answer(readText($, e as unknown as { path?: unknown; recent?: unknown })),
  ).catch(hookFailed)
  on('tool.call', { tool: `${TOOL_PREFIX}ask_photo` }, ($, e) =>
    answer(askPhoto($, e as unknown as { question?: unknown; path?: unknown; recent?: unknown })),
  ).catch(hookFailed)

  on('command.run', { command: 'snap' }, async ($, e) => {
    const arg = e.args.trim() || 'iphone'
    if (arg === 'pane' || arg === 'live') {
      const placed = await openLive($)

      return { text: placed ? 'Панель SnapCam открыта' : 'Панель SnapCam ждёт места: расширь окно', isTextDisplayOnly: true }
    }
    if (arg === 'caps' || arg === 'status' || arg === 'pair' || arg === 'list') {
      const cli = await findCli($, await paths($))
      if (!cli) return { text: 'SnapCam для Mac не установлен: собери его из snapcam-app скриптом scripts/install-mac.sh' }
      // `list` = the sources in `state`.
      const run = await $.process.run([cli, arg === 'list' ? 'state' : arg], { timeoutMs: 60_000 })

      return { text: (run.stdout + run.stderr).trim() || `snapcam-cli: код ${run.exitCode}` }
    }
    const mode = CAMERAS.find(c => c === arg) ?? 'iphone'

    return { text: await snapToTray($, mode), isTextDisplayOnly: true }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin?.kind === 'plugin') return next(e)
    resetBackoff()
    // Take the tray only if some surface shows it; headless runs never consume it.
    const shown = (await $.session.surfaces()).some(surface => surface !== 'mobile')
    let tray: string[] = []
    let fromPhone: InboxItem[] = []
    const held: string[] = []
    if (!shown) {
      const band = await read($, pending)
      const phone = (await read($, phoneTray)).length
      if (band.length > 0) held.push(`Camera shots wait in the SnapCam tray, not attached: ${band.join(', ')}.`)
      if (phone > 0) held.push(`${phone} phone photo(s) wait in the SnapCam tray, not attached; recent_photos reads them.`)
    } else {
      await update($, pending, list => {
        tray = [...list]
        return list.length > 0 ? [] : list
      })
      // Same tick as the read: an overlapping submit skips these.
      fromPhone = (await read($, phoneTray)).filter(item => !taking.has(item.id))
      for (const item of fromPhone) taking.add(item.id)
    }
    const typed = e.text.match(SNAP_PATH) ?? []
    if (tray.length + fromPhone.length + typed.length === 0) {
      return held.length > 0 ? next({ ...e, context: [...(e.context ?? []), ...held] }) : next(e)
    }
    let phoneShots: string[] = []
    try {
      phoneShots = fromPhone.length > 0 ? await takeTray($, fromPhone) : []
    } finally {
      for (const item of fromPhone) taking.delete(item.id)
    }
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
      context: [...(e.context ?? []), note, ...held],
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
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    // The terminal's table has no Svg: the name, without building the picture.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const name = await read($, viewing)
    if (!name) return <Text dimColor>Фото не найдено</Text>
    if (!Svg) return <Text dimColor>{name}</Text>
    const svg = await previewSvg($, name)
    if (!svg) return <Text dimColor>Фото не найдено: {name}</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Svg source={svg} alt={name} />
        <Text dimColor>{name}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface === 'mobile') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const now = await read($, busy)
    const shots = (await read($, pending)).map(path => ({ key: path, name: baseName(path), id: '', original: '' }))
    const fromPhone = (await read($, phoneTray)).map(item => ({ key: item.id, ...item }))
    const tray = [...shots, ...fromPhone]
    const canDraw = !!Svg
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
                  {svg && Svg ? (
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
        {now !== '' ? (
          <Text dimColor>SnapCam: снимает {SHORT[now as SnapMode] ?? 'камера'}…</Text>
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
            <Button key={LIVE_PANE} label="🎥 Панель" onPress={() => void openLive($)} />,
          ]
        )}
        </Box>
      </Box>
    )
  })
}
