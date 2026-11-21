import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SnapMode } from '../types'

const busy = atom({ plugin: 'snap-cam', key: 'busy' } as const, '')
const pending = atom({ plugin: 'snap-cam', key: 'pending' } as const, [] as string[])
const viewing = atom({ plugin: 'snap-cam', key: 'viewing' } as const, '')
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

const SNAP_PATH =/\/\S*\/Pictures\/ClaudeSnaps\/[\w.-]+\.jpg/g
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

type Paths = { dir: string; app: string; snaps: string; status: string; thumbs: string; home: string }

type Shot = { delay: string; flash?: Flash; lens?: Lens; zoom?: number }
type Taken = { path: string; note: string }
// Why the iPhone app path fell through to Continuity.
type Skipped = { reason: string; offline: boolean }
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
    snaps: `${home}/Pictures/ClaudeSnaps`,
    status: `${dir}/last.status`,
    thumbs: `${dir}/thumbs`,
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

async function makeThumb($: EngineInterface, p: Paths, photo: string): Promise<void> {
  await $.process.run(['mkdir', '-p', p.thumbs])
  await $.process.run(['sips', '-Z', String(THUMB * 2), photo, '--out', `${p.thumbs}/${baseName(photo)}`])
}

async function findCli($: EngineInterface, p: Paths): Promise<string | null> {
  const own = await $.env.get('SNAPCAM_CLI')
  for (const path of [own, `${p.home}/Applications/${CLI_IN_APP}`, `/Applications/${CLI_IN_APP}`]) {
    if (path && (await $.fs.exists(path))) return path
  }

  return null
}

function parseJson(text: string): PhoneJson {
  try {
    return JSON.parse(text.trim().split('\n').pop() ?? '') as PhoneJson
  } catch {
    return {}
  }
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
async function openPreview($: EngineInterface, name: string): Promise<void> {
  const p = await paths($)
  const src = `${p.snaps}/${name}`
  const file = `${p.dir}/previews/${name}`
  if (!(await $.fs.exists(`${file}.json`)) && (await $.fs.exists(src))) {
    await $.process.run(['mkdir', '-p', `${p.dir}/previews`])
    for (const side of [800, 600, 420]) {
      await $.process.run(['sips', '-Z', String(side), '-s', 'formatOptions', '55', src, '--out', file])
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
        'Unless the phone sits on a stand, tell the user what to point it at and give them a few seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          camera: { type: 'string', enum: ['iphone', 'desk'], description: 'iphone or desk (Desk View, top-down)' },
          delay_seconds: { type: 'number', minimum: 0, maximum: 60, description: 'Wait before the shot; 0 = right away' },
          flash: { type: 'string', enum: FLASHES, description: "iPhone only; default: the user's choice" },
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
  }).catch(($, e, next) => ({ deny: `SnapCam hook ${next.error.kind}: ${next.error.message ?? 'no message'}` }))

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
    if (e.command || e.isMeta || e.origin.kind === 'plugin') return next(e)
    const tray = await read($, pending)
    const typed = e.text.match(SNAP_PATH) ?? []
    const found = [...new Set([...tray, ...typed])]
    if (found.length === 0) return next(e)
    await update($, pending, () => [])
    const lines = tray.map(path => `📷 ${baseName(path)}`).join('\n')
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
    const tray = await read($, pending)
    const canDraw = e.surface !== 'terminal'
    const chips = canDraw ? await Promise.all(tray.map(path => chipSvg($, baseName(path)))) : []

    return (
      <Box flexDirection="column" gap={1}>
        {tray.length > 0 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            {tray.map((path, i) => {
              const svg = chips[i]
              return (
                <Box key={path} flexDirection="row" alignItems="center">
                  {svg ? (
                    <Svg source={svg} alt={baseName(path)} width={THUMB / 2} height={THUMB / 2} />
                  ) : (
                    <Text>📷 {baseName(path)}</Text>
                  )}
                  <Button
                    key={`zoom:${path}`}
                    label="🔍"
                    plain
                    onPress={() => void openPreview($, baseName(path))}
                  />
                  <Button
                    key={`x:${path}`}
                    label="✕"
                    plain
                    onPress={() => update($, pending, list => list.filter(one => one !== path))}
                  />
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
