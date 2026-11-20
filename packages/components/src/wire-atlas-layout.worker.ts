import { rearrangeAtlas, type AtlasState } from './wire-atlas-model.js'
import { compactNeighborhood } from './wire-atlas-neighborhood.js'

// One disposable worker per requested arrangement. Termination cancels the CPU work.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ state: AtlasState; centerId?: string }>) => void) | null
  postMessage(value: unknown): void
}
worker.onmessage = ({ data }) => {
  try {
    worker.postMessage({ state: data.centerId ? compactNeighborhood(data.state, data.centerId) : rearrangeAtlas(data.state) })
  } catch (error) {
    worker.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
