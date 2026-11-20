import { describe, expect, it } from 'vitest'
import type { RenderWorkspaceOptions } from '@shrubbery/runtime'
import { withPaneReadAloud } from '../pane-read-aloud.js'

function snapshot(available: boolean): RenderWorkspaceOptions {
  const editorHosts = new Map([
    ['left', { binding: {} }],
    ['right', { binding: {} }],
  ])
  return {
    tts: { available, status: 'idle' },
    centerPanes: { projection: { activePaneId: 'right', panes: [] }, editorHosts },
  } as unknown as RenderWorkspaceOptions
}

describe('withPaneReadAloud', () => {
  it('gives the active pane the read-aloud state, and only that pane', () => {
    const out = withPaneReadAloud(snapshot(true))
    const hosts = out.centerPanes!.editorHosts
    expect(hosts.get('right' as never)).toMatchObject({ ttsAvailable: true, ttsStatus: 'idle' })
    expect(hosts.get('left' as never)).not.toHaveProperty('ttsAvailable')
  })

  it('leaves a snapshot without read-aloud or panes alone', () => {
    const plain = { centerPanes: null } as unknown as RenderWorkspaceOptions
    expect(withPaneReadAloud(plain)).toBe(plain)
  })
})
