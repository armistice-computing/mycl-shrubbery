import { describe, expect, it } from 'vitest'
import { LoopbackWireWriter } from '../gardend-contract.js'
import type { LoopbackMcpClient } from '../loopback-mcp.js'

interface Call { name: string; args: Record<string, unknown> }

function mcp(reply: (call: Call) => Record<string, unknown>): { client: LoopbackMcpClient; calls: Call[] } {
  const calls: Call[] = []
  const client = {
    async toolsCall(name: string, args: Record<string, unknown>) {
      const call = { name, args }
      calls.push(call)
      return reply(call)
    },
  } as unknown as LoopbackMcpClient
  return { client, calls }
}

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

describe('LoopbackWireWriter file links', () => {
  it('sends the path and region to create_wires and reads back the file record', async () => {
    const { client, calls } = mcp(() => text({ created: [{ id: 'wire-1', targetArtifactId: 'artifact-plan', targetRegion: { kind: 'text-lines', start: 5, end: 8 } }] }))
    const writer = new LoopbackWireWriter(client)
    const created = await writer.createFileLink('g', {
      sourceDocumentId: 'doc-1',
      sourceBlockId: 'block-7',
      artifactPath: '/Users/me/plan.md',
      region: 'L5-L8',
      wireId: 'wire-1',
    })
    expect(created).toEqual({ wireId: 'wire-1', targetArtifactId: 'artifact-plan' })
    expect(calls).toEqual([{
      name: 'create_wires',
      args: {
        graphId: 'g',
        wires: [{
          sourceDocumentId: 'doc-1',
          sourceBlockId: 'block-7',
          artifactPath: '/Users/me/plan.md',
          region: 'L5-L8',
          wireId: 'wire-1',
          bidirectional: false,
        }],
      },
    }])
  })

  it('throws the cell\'s reason when the tool refuses', async () => {
    const { client } = mcp(() => ({ isError: true, content: [{ type: 'text', text: 'wire 0: denied: /etc/hosts is outside the allowed roots; no wires were created' }] }))
    const writer = new LoopbackWireWriter(client)
    await expect(writer.createFileLink('g', { sourceDocumentId: 'd', artifactPath: '/etc/hosts', region: 'L1', wireId: 'w' }))
      .rejects.toThrow(/outside the allowed roots/)
  })

  it('reads a link\'s region by wire id', async () => {
    const { client, calls } = mcp(() => ({ structuredContent: { regionText: 'five', stale: { file: false, region: false } } }))
    const writer = new LoopbackWireWriter(client)
    expect(await writer.readFileLink('g', 'wire-1')).toEqual({ regionText: 'five', stale: { file: false, region: false } })
    expect(calls[0]).toEqual({ name: 'read_artifact', args: { graphId: 'g', wireId: 'wire-1', maxChars: 8000 } })
    await writer.readFileLink('g', 'wire-1', 'L8-L11')
    expect(calls[1]).toEqual({ name: 'read_artifact', args: { graphId: 'g', wireId: 'wire-1', maxChars: 8000, region: 'L8-L11' } })
  })
})
