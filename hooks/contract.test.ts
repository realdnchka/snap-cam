import { expect, test } from 'claude-code/testing'

import { contract } from '../contract.ts'

type Spec = { name: string; inputSchema?: { properties?: Record<string, unknown> } }

// Backticked words of a Markdown detail, as SnapCamKit's CLISyntax.codeWords.
function codeWords(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`]+)`/g)].flatMap(m => m[1].split(/[\s,]+/).filter(Boolean))
}

test('every MCP cell that works names a registered tool and its inputs', async ($, on) => {
  const tools = new Map<string, Spec>()
  on('command.register', () => ({ value: { command: 'snap' } }))
  on('tool.register', (_, e) => {
    const spec = e as unknown as Spec
    tools.set(spec.name, spec)

    return { value: { tool: `mcp__snap-cam__${spec.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const cells = contract.cells.mcp as Record<string, { status: string; detail?: string }>
  const working = Object.entries(cells).filter(([, cell]) => cell.status === 'available')
  expect(working.length).toBeGreaterThan(0)
  for (const [command, cell] of working) {
    const [tool, ...inputs] = codeWords(cell.detail ?? '')
    expect({ command, tool: tools.has(tool) }).toEqual({ command, tool: true })
    const properties = Object.keys(tools.get(tool)?.inputSchema?.properties ?? {})
    for (const input of inputs) {
      expect({ command, input, ok: properties.includes(input) }).toEqual({ command, input, ok: true })
    }
  }
})

test('per-shot framing and flash are take_photo inputs', () => {
  const cells = contract.cells.mcp as Record<string, { status: string; detail?: string }>
  expect(codeWords(cells.frameLens.detail ?? '')).toEqual(['take_photo', 'lens'])
  expect(codeWords(cells.frameZoom.detail ?? '')).toEqual(['take_photo', 'zoom'])
  expect(codeWords(cells.flash.detail ?? '')).toEqual(['take_photo', 'flash'])
})
