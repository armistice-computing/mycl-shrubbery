import { describe, expect, it } from 'vitest'
import { VaultCaptureClient, type VaultInvoke } from '../vault-capture.js'

function recording(responses: Record<string, unknown>) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    return responses[command]
  }) as VaultInvoke
  return { calls, client: new VaultCaptureClient(invoke) }
}

describe('VaultCaptureClient', () => {
  it('opens the chooser with the graph and the kind, and no path', async () => {
    const { calls, client } = recording({
      select_vault_source: { scanId: 'scan-1', graphId: 'g', state: 'capturing', graphWrites: false },
    })
    expect(await client.select('g', 'zip')).toEqual({ state: 'capturing', scanId: 'scan-1', graphId: 'g' })
    expect(calls).toEqual([{ command: 'select_vault_source', args: { graphId: 'g', kind: 'zip' } }])
  })

  it('reads a cancelled chooser as no scan', async () => {
    const { client } = recording({ select_vault_source: { state: 'cancelled', graphWrites: false } })
    expect(await client.select('g', 'folder')).toEqual({ state: 'cancelled' })
  })

  it('pages the status within the node limit and keeps only well-formed entries', async () => {
    const { calls, client } = recording({
      get_vault_capture_status: {
        state: 'ready',
        expiresAt: 1_800_000_000_000,
        fingerprint: 'fp',
        error: null,
        totalEntries: 2,
        entries: [
          { index: 0, path: 'Notes/a.md', kind: 'note', bytes: 12, sha256: 'x' },
          { index: 1, kind: 'note' },
        ],
        nextOffset: null,
        complete: true,
        graphWrites: false,
      },
    })
    const status = await client.status('g', 'scan-1', 50, 500)
    expect(calls[0]).toEqual({ command: 'get_vault_capture_status', args: { graphId: 'g', scanId: 'scan-1', offset: 50, limit: 50 } })
    expect(status.state).toBe('ready')
    expect(status.entries.map(entry => entry.path)).toEqual(['Notes/a.md'])
    expect(status.complete).toBe(true)
  })

  it('treats an unknown state as failed', async () => {
    const { client } = recording({ get_vault_capture_status: { state: 'sideways' } })
    expect((await client.status('g', 's')).state).toBe('failed')
  })

  it('reports what cancel actually did', async () => {
    const { client } = recording({ cancel_vault_capture: { state: 'failed', cancelled: false } })
    expect(await client.cancel('g', 's')).toEqual({ state: 'failed', cancelled: false })
  })
})
