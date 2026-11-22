import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SnapMode } from '../types'

const busy = atom({ plugin: 'snap-cam', key: 'busy' } as const, '')
const pending = atom({ plugin: 'snap-cam', key: 'pending' } as const, [] as string[])

// Camera → snapcam-cli --source (ADR 0004); `external` only in the pane.
export const SOURCES: Record<SnapMode, { source: string; title: string }> = {
  iphone: { source: 'phone', title: 'SnapCam iPhone app' },
  continuity: { source: 'continuity', title: 'Continuity Camera' },
  desk: { source: 'deskView', title: 'Desk View' },
  mac: { source: 'builtIn', title: "Mac's built-in camera" },
  external: { source: 'external', title: 'external camera' },
}
// take_photo and peek cameras: the MCP enums.
export const CAMERAS: SnapMode[] = ['iphone', 'continuity', 'desk', 'mac']
export const INSTALL = 'SnapCam for Mac is not installed: build it from snapcam-app with scripts/install-mac.sh'

export type Flash = 'off' | 'on' | 'auto'
export type Lens = 'ultraWide' | 'wide' | 'telephoto'
export const FLASHES: Flash[] = ['off', 'on', 'auto']
export const LENSES: Lens[] = ['ultraWide', 'wide', 'telephoto']

export const CLI_USAGE = 64

// snapcam-cli from SnapCam for Mac (repo snapcam-app); 69 = no app, phone or camera.
export const CLI_IN_APP = 'SnapCam.app/Contents/Helpers/snapcam-cli'
export const CLI_TIMEOUT_S = 25
// A wireless iPhone can take 10–20 s to appear as a Mac camera.
export const MAC_TIMEOUT_S = 55
// First OCR or model run loads assets: can take a minute.
export const READ_TIMEOUT_S = 150
// User shots fire at once: they aim before pressing.
export const MANUAL_COUNTDOWN_S = 0
export const CLI_UNAVAILABLE = 69
// Paired phone around but not connected after the app's ~10 s wait; nothing was shot.
export const CLI_OFFLINE = 75
export const SIDE = 2400

export const THUMB = 96

export type Paths = { dir: string; snaps: string; thumbs: string; staging: string; recent: string; home: string }

export type Shot = { delay: string; flash?: Flash; lens?: Lens; zoom?: number }
export type Taken = { path: string; note: string }

export type Cli = { exitCode: number; stdout: string; reason: string }

export type PhoneJson = {
  original?: string; preview?: string; width?: number; height?: number; format?: string
  lens?: string; zoom?: number; phone?: string; ms?: number; error?: string
  originalPending?: boolean; timings?: Record<string, number>
}

// Stage timings for the note; CLI and mod totals leave out the countdown.
export function timingNote(json: Partial<PhoneJson>, modMs: number, delayMs: number): string {
  const t = json.timings
  if (!t) return `${json.ms ?? '?'} ms`
  const parts = [
    t.phoneShutter !== undefined ? `shutter ${t.phoneShutter}` : '',
    t.phoneProcessed !== undefined ? `processed ${t.phoneProcessed}` : '',
    t.macReady !== undefined ? `on Mac ${t.macReady}` : '',
    t.cliTotal !== undefined ? `cli ${Math.max(t.cliTotal - delayMs, 0)}` : '',
    `total ${Math.max(modMs - delayMs, 0)}`,
  ].filter(Boolean)
  return `${parts.join(', ')} ms${delayMs > 0 ? ` after the ${delayMs / 1000} s delay` : ''}`
}

export async function paths($: EngineInterface): Promise<Paths> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${home}/Library/Application Support/snap-cam`

  return {
    dir,
    snaps: `${home}/Pictures/SnapCam/ClaudeSnaps`,
    thumbs: `${dir}/thumbs`,
    staging: `${dir}/inbox-staging`,
    recent: `${dir}/recent-staging`,
    home,
  }
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const slug = (text: string) => text.replace(/[^\w.-]+/g, '-')

// One chat-safe copy per original: a non-JPEG extension stays in the name.
export function recentName(original: string): string {
  const base = baseName(original)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  const kind = ext && !/^jpe?g$/i.test(ext) ? `-${slug(ext.toLowerCase())}` : ''

  return `recent-${slug(stem)}${kind}.jpg`
}

export function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

export async function makeThumb($: EngineInterface, p: Paths, photo: string, name = baseName(photo)): Promise<void> {
  await $.process.run(['mkdir', '-p', p.thumbs])
  await $.process.run(['sips', '-s', 'format', 'jpeg', '-Z', String(THUMB * 2), photo, '--out', `${p.thumbs}/${name}`])
}

export async function findCli($: EngineInterface, p: Paths): Promise<string | null> {
  const own = await $.env.get('SNAPCAM_CLI')
  for (const path of [own, `${p.home}/Applications/${CLI_IN_APP}`, `/Applications/${CLI_IN_APP}`]) {
    if (path && (await $.fs.exists(path))) return path
  }

  return null
}

// The CLI prints one JSON line last.
export function parseJson<T = PhoneJson>(text: string): Partial<T> {
  try {
    return (JSON.parse(text.trim().split('\n').pop() ?? '') ?? {}) as Partial<T>
  } catch {
    return {}
  }
}

export async function runCli($: EngineInterface, cli: string, args: string[], timeoutS = CLI_TIMEOUT_S): Promise<Cli> {
  const run = await $.process.run([cli, ...args], { timeoutMs: timeoutS * 1000 })
  const reason =
    parseJson<{ error: string }>(run.stdout).error ??
    (run.stderr.trim().replace(/^snapcam-cli: /, '') || `snapcam-cli exit ${run.exitCode}`)

  return { exitCode: run.exitCode, stdout: run.stdout, reason }
}

export function cliFailure(run: Cli): string {
  const why =
    run.exitCode === CLI_UNAVAILABLE ? 'SnapCam for Mac, the paired iPhone or that camera is not reachable'
    : run.exitCode === CLI_OFFLINE ? 'the paired iPhone did not connect in time'
    : run.exitCode === CLI_USAGE ? 'bad arguments (is SnapCam for Mac up to date?)'
    : 'the camera or the Mac app reported an error'

  return `${why}: ${run.reason}`
}

// Known CLI reasons, for the pane; the Mac app's own messages come localized.
const REASONS: Record<string, string> = {
  "SnapCam isn't running.": 'SnapCam не запущен.',
  'Timed out. Is the camera still on?': 'Камера не ответила вовремя. Она ещё включена?',
  'Timed out. Is SnapCam open on the iPhone?': 'Камера не ответила вовремя. SnapCam открыт на iPhone?',
  'Timed out. Is the camera still connected?': 'Камера не ответила вовремя. Она ещё подключена?',
  "SnapCam.app isn't installed.": 'SnapCam.app не установлен.',
  'unexpected answer': 'неожиданный ответ',
  "SnapCam didn't list its photos in time.": 'SnapCam не успел показать фото.',
}

// Reasons that carry a path.
const LANDING = /(?:The last photo is )?still on its way from the iPhone \((.+?)\)\. Try again shortly\./g

export function paneReason(reason: string): string {
  const known = REASONS[reason.trim()]
  if (known) return known

  return reason.replace(LANDING, (_, path: string) => `Фото ещё едет с iPhone (${path.split('/').pop()}). Повтори чуть позже.`)
}

// cliFailure in Russian, for the pane and the band; the model keeps English.
export function paneFailure(run: Pick<Cli, 'exitCode' | 'reason'>, what?: 'ask'): string {
  const transport = REASONS[run.reason.trim()] !== undefined
  const why =
    run.exitCode === CLI_UNAVAILABLE
      ? what === 'ask' && !transport ? 'Apple Intelligence выключен или недоступен' : 'SnapCam для Mac, iPhone или камера недоступны'
    : run.exitCode === CLI_OFFLINE ? 'iPhone не подключился вовремя'
    : run.exitCode === CLI_USAGE ? 'неверные аргументы — обнови SnapCam для Mac'
    : 'камера или приложение сообщили об ошибке'

  return `${why}: ${paneReason(run.reason)}`
}

// A failed CLI run; the UI formats `run` in Russian.
export class CliError extends Error {
  constructor(readonly run: Cli) {
    super(cliFailure(run))
  }
}

export const RECENT_MAX = 5

export type Paragraph = { text?: string; area?: string }
export type PhotoText = { path?: string; paragraphs?: Paragraph[] }

// `path` wins; else the newest `recent` (default 1) of the save folder.
export function photoArgs(input: { path?: unknown; recent?: unknown }): string[] {
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (path) return [path]
  const asked = Math.floor(Number(input.recent))

  return ['--recent', String(asked >= 1 ? Math.min(asked, RECENT_MAX) : 1)]
}

export function describeText(photos: PhotoText[]): string {
  return photos
    .map(photo => {
      const paragraphs = (photo.paragraphs ?? []).filter(p => p.text?.trim())
      const body = paragraphs.length ? paragraphs.map(p => `[${p.area ?? '?'}] ${p.text}`).join('\n') : '(no text found)'
      return `Photo: ${photo.path ?? '?'}\n${body}`
    })
    .join('\n\n')
}

export async function needCli($: EngineInterface, p: Paths): Promise<string> {
  const cli = await findCli($, p)
  if (!cli) throw new Error(INSTALL)

  return cli
}

export const times = (zoom: number) => `${Number(zoom.toFixed(1))}×`

// Every camera goes through SnapCam for Mac; a numeric delay shoots by itself.
export async function shoot($: EngineInterface, mode: SnapMode, shot: Shot): Promise<Taken> {
  const started = await $.clock.now()
  const p = await paths($)
  const cli = await findCli($, p)
  if (!cli) throw new Error(INSTALL)
  const out = `${p.snaps}/${mode}-${stamp(started)}.jpg`
  await $.process.run(['mkdir', '-p', p.snaps])
  await $.fs.write(`${p.dir}/last-mode.txt`, mode)
  const { source, title } = SOURCES[mode]
  const phone = mode === 'iphone'
  const delay = shot.delay === 'manual' ? MANUAL_COUNTDOWN_S : Number(shot.delay)
  const timeout = phone ? CLI_TIMEOUT_S : MAC_TIMEOUT_S
  const argv = [cli, 'capture', ...(phone ? [] : ['--source', source]), '--json', '--delay', String(delay), '--timeout', String(timeout)]
  argv.push('--preview', out, '--preview-size', String(SIDE))
  // Mac cameras have no lenses; zoom is a 1–3× crop there.
  if (shot.lens && phone) argv.push('--lens', shot.lens)
  if (shot.zoom !== undefined) argv.push('--zoom', String(shot.zoom))
  // Unset options use the Mac app's settings for that camera.
  if (shot.flash) argv.push('--flash', shot.flash)
  const run = await $.process.run(argv, { timeoutMs: (timeout + delay + 30) * 1000 })
  const json = parseJson(run.stdout)
  const reason = json.error ?? (run.stderr.trim().replace(/^snapcam-cli: /, '') || `snapcam-cli exit ${run.exitCode}`)
  if (run.exitCode !== 0 || !json.preview) throw new CliError({ exitCode: run.exitCode, stdout: run.stdout, reason })
  await makeThumb($, p, json.preview)
  const lens = phone ? `lens ${json.lens ?? 'auto'}` : 'crop zoom'
  const lensNote = shot.lens && !phone ? '; lens ignored' : ''
  const note =
    `${json.phone ?? 'camera'} (${title}): ${json.width}×${json.height} ${json.format ?? ''}, ` +
    `${lens}${json.zoom !== undefined ? ` ${times(json.zoom)}` : ''}${lensNote}, ` +
    `${timingNote(json, (await $.clock.now()) - started, delay * 1000)}. Original: ${json.original}` +
    (json.originalPending ? ' (still arriving from the iPhone)' : '')

  return { path: json.preview, note }
}

export async function lastMode($: EngineInterface): Promise<SnapMode> {
  const file = `${(await paths($)).dir}/last-mode.txt`
  const saved = (await $.fs.exists(file)) ? (await $.fs.read(file)).trim() : ''

  return CAMERAS.find(mode => mode === saved) ?? 'iphone'
}

export async function snapToTray($: EngineInterface, mode: SnapMode, delay = 'manual'): Promise<string> {
  if ((await read($, busy)) !== '') return 'SnapCam уже снимает'
  await update($, busy, () => mode)
  try {
    const { path } = await shoot($, mode, { delay })
    await update($, pending, list => [...list, path])

    return `Фото прикреплено: ${baseName(path)}`
  } catch (error) {
    const why = error instanceof CliError ? paneFailure(error.run) : error instanceof Error ? error.message : String(error)
    const msg = `SnapCam: ${why}`
    $.ui.toast(msg)

    return msg
  } finally {
    await update($, busy, () => '')
  }
}

// Square rounded chip with the photo cropped to fit.
export async function chipSvg($: EngineInterface, name: string, side = THUMB): Promise<string | null> {
  const p = await paths($)
  const file = `${p.thumbs}/${name}`
  if (!(await $.fs.exists(file))) return null
  const { base64 } = await $.fs.read(file, { as: 'bytes' })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">` +
    `<defs><clipPath id="r"><rect width="${side}" height="${side}" rx="10"/></clipPath></defs>` +
    `<image clip-path="url(#r)" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" ` +
    `href="data:image/jpeg;base64,${base64}"/></svg>`
  )
}
