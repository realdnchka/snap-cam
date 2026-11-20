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
const TOOL = 'mcp__snap-cam__take_photo'

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

type Paths = { dir: string; app: string; snaps: string; status: string; thumbs: string }

async function paths($: EngineInterface): Promise<Paths> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${home}/Library/Application Support/snap-cam`

  return {
    dir,
    app: `${dir}/SnapCam.app`,
    snaps: `${home}/Pictures/ClaudeSnaps`,
    status: `${dir}/last.status`,
    thumbs: `${dir}/thumbs`,
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
  await $.process.run(['pkill', '-x', 'SnapCam'])
  await $.process.run(['open', '-W', '-n', p.app, '--args', ...args, p.status, ...extra], {
    timeoutMs: 600_000,
  })

  return (await $.fs.exists(p.status)) ? (await $.fs.read(p.status)).trim() : 'SnapCam не ответил'
}

async function makeThumb($: EngineInterface, p: Paths, photo: string): Promise<void> {
  await $.process.run(['mkdir', '-p', p.thumbs])
  await $.process.run(['sips', '-Z', String(THUMB * 2), photo, '--out', `${p.thumbs}/${baseName(photo)}`])
}

// Returns the photo path, or throws with a reason. A numeric delay shoots by itself.
async function shoot($: EngineInterface, mode: SnapMode, delay = 'manual', flash?: Flash): Promise<string> {
  const p = await paths($)
  const err = await ensureApp($, p)
  if (err) throw new Error(err)
  const out = `${p.snaps}/${mode}-${stamp(await $.clock.now())}.jpg`
  await $.fs.write(`${p.dir}/last-mode.txt`, mode)
  const said = await runHelper($, p, [mode, out, delay], flash ? [flash] : [])
  if (said !== out) throw new Error(said)
  await makeThumb($, p, out)

  return out
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
    const out = await shoot($, mode, delay)
    await update($, pending, list => [...list, out])

    return `Фото прикреплено: ${baseName(out)}`
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
      argumentHint: 'iphone | desk | list',
    })
    await $.tool.register({
      name: 'take_photo',
      description:
        "Take a photo with the user's iPhone (Continuity Camera) or the Desk View camera on their Mac and " +
        'get the image back. A preview window with the capture frame opens on the Mac; after a ~1.5 s ' +
        'warm-up the shot is taken by itself once delay_seconds pass. The user can cancel with Esc. ' +
        'Unless the phone sits on a stand, tell the user what to point it at and give them a few seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          camera: { type: 'string', enum: ['iphone', 'desk'], description: 'iphone or desk (Desk View, top-down)' },
          delay_seconds: { type: 'number', minimum: 0, maximum: 60, description: 'Wait before the shot; 0 = right away' },
          flash: { type: 'string', enum: ['off', 'on', 'auto'], description: "iPhone only; default: the user's choice" },
        },
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { camera?: string; delay_seconds?: number; flash?: string }
    const mode: SnapMode = input.camera === 'desk' ? 'desk' : 'iphone'
    const delay = String(Math.min(Math.max(Number(input.delay_seconds ?? 3) || 0, 0), 60))
    const flash = ['off', 'on', 'auto'].includes(input.flash ?? '') ? (input.flash as Flash) : undefined
    if ((await read($, busy)) !== '') return { deny: 'SnapCam is busy with another shot' }
    await update($, busy, () => mode)
    try {
      const out = await shoot($, mode, delay, flash)
      const { base64 } = await $.fs.read(out, { as: 'bytes' })
      const p = await paths($)
      const shot = (await $.fs.exists(`${p.dir}/last-shot.txt`)) ? await $.fs.read(`${p.dir}/last-shot.txt`) : ''

      return {
        result: [
          { type: 'text', text: `Photo saved: ${out}${shot ? ` (${shot})` : ''}` },
          { type: 'image', data: base64, mimeType: 'image/jpeg' },
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
        {now !== '' ? (
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
