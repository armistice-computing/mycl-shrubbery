import type { AtlasState } from './wire-atlas-model.js'

/** Single outstanding layout; disposal settles the promise and invalidates late replies. */
export class AtlasLayoutClient {
  private cancelCurrent: (() => void) | null = null

  cancel(): void { this.cancelCurrent?.() }

  run(state: AtlasState, centerId?: string): Promise<AtlasState | null> {
    this.cancel()
    return new Promise((resolve, reject) => {
      let worker: Worker
      try {
        worker = new Worker(new URL('./wire-atlas-layout.worker.ts', import.meta.url), { type: 'module' })
      } catch (error) { reject(error); return }
      let done = false
      const finish = (value: AtlasState | null, error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        worker.terminate()
        this.cancelCurrent = null
        if (error) reject(error)
        else resolve(value)
      }
      const timeout = setTimeout(() => finish(null, new Error('Atlas layout timed out; existing positions were kept.')), 30_000)
      this.cancelCurrent = () => finish(null)
      worker.onmessage = ({ data }: MessageEvent<{ state?: AtlasState; error?: string }>) => {
        if (data.error || !data.state) finish(null, new Error(data.error ?? 'Atlas layout returned no state'))
        else finish(data.state)
      }
      worker.onerror = event => finish(null, new Error(event.message || 'Atlas layout worker failed'))
      worker.onmessageerror = () => finish(null, new Error('Could not read atlas layout result'))
      try { worker.postMessage({ state, centerId }) } catch (error) {
        finish(null, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
