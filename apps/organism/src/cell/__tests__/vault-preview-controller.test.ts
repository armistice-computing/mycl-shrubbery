import { describe, expect, it } from 'vitest'
import { VaultCaptureClient, type VaultInvoke } from '../vault-capture.js'
import { VaultPreviewController, phaseForError, type VaultPreviewView } from '../vault-preview-controller.js'

function entries(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({ index: from + i, path: `Notes/n${from + i}.md`, kind: 'note', bytes: 10, sha256: 's' }))
}

function setup(script: (command: string, args: Record<string, unknown>) => unknown) {
  const calls: string[] = []
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push(command)
    const value = script(command, args ?? {})
    if (value instanceof Error) throw value
    return value
  }) as VaultInvoke
  const views: VaultPreviewView[] = []
  const controller = new VaultPreviewController({
    client: new VaultCaptureClient(invoke),
    render: view => views.push(view),
    wait: async () => {},
  })
  return { calls, views, controller }
}

describe('VaultPreviewController', () => {
  it('scans until ready, then pages with Show more', async () => {
    let reads = 0
    const { controller } = setup((command, args) => {
      if (command === 'select_vault_source') return { scanId: 's1', graphId: 'g', state: 'capturing', graphWrites: false }
      if (command === 'get_vault_capture_status') {
        reads++
        if (reads === 1) return { state: 'capturing', totalEntries: 0, entries: [] }
        const offset = Number(args.offset)
        const page = entries(offset, Math.min(50, 120 - offset))
        const next = offset + page.length
        return { state: 'ready', totalEntries: 120, entries: page, nextOffset: next < 120 ? next : null, complete: next >= 120 }
      }
      return null
    })
    await controller.choose('g', 'folder')
    expect(controller.current.phase).toBe('ready')
    expect(controller.current.entries).toHaveLength(50)
    expect(controller.current.hasMore).toBe(true)
    await controller.showMore()
    await controller.showMore()
    expect(controller.current.entries).toHaveLength(120)
    expect(controller.current.hasMore).toBe(false)
  })

  it('stays closed when the chooser is cancelled', async () => {
    const { controller, calls } = setup(() => ({ state: 'cancelled', graphWrites: false }))
    await controller.choose('g', 'zip')
    expect(controller.current.open).toBe(false)
    expect(calls).toEqual(['select_vault_source'])
  })

  it('shows an expired scan as expired, and a vanished one too', async () => {
    const { controller } = setup(command => command === 'select_vault_source'
      ? { scanId: 's1', graphId: 'g', state: 'capturing' }
      : { state: 'expired', totalEntries: 0, entries: [] })
    await controller.choose('g', 'folder')
    expect(controller.current.phase).toBe('expired')
    expect(phaseForError('capture unavailable')).toBe('expired')
  })

  it('shows a refused scan when the graph was replaced', async () => {
    const { controller } = setup(command => command === 'select_vault_source'
      ? { scanId: 's1', graphId: 'g', state: 'capturing' }
      : new Error('graph incarnation changed; scan refused'))
    await controller.choose('g', 'folder')
    expect(controller.current.phase).toBe('refused')
  })

  it('cancels a running scan when the dialog closes', async () => {
    const { controller, calls } = setup(command => {
      if (command === 'select_vault_source') return { scanId: 's1', graphId: 'g', state: 'capturing' }
      if (command === 'cancel_vault_capture') return { state: 'cancelled', cancelled: true }
      return { state: 'capturing', entries: [] }
    })
    const scanning = controller.choose('g', 'folder')
    await Promise.resolve()
    await Promise.resolve()
    controller.close()
    await scanning
    expect(controller.current.open).toBe(false)
    expect(calls).toContain('cancel_vault_capture')
  })
})
