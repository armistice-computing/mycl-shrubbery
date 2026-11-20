import { LitElement, css, html, nothing, unsafeCSS } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermStyles from '@xterm/xterm/css/xterm.css?raw'
import { SkinAware } from './skin-aware.js'

export type MnTerminalStatus = 'idle' | 'opening' | 'live' | 'exited' | 'error'

export interface MnTerminalSize {
  readonly cols: number
  readonly rows: number
}

export interface MnTerminalInputDetail {
  readonly data: string
}

@customElement('mn-terminal-pane')
export class MnTerminalPane extends SkinAware(LitElement) {
  static styles = css`
    ${unsafeCSS(xtermStyles)}

    :host {
      /* The rail lays its panel out in a flex row: without a width of its
         own the pane is only as wide as its header. */
      display: flex;
      flex: 1 1 auto;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      min-height: 0;
      height: 100%;
      flex-direction: column;
      overflow: hidden;
      background: var(--mn-color-surface-base, #fff);
      color: var(--mn-color-text-primary, #111827);
      font-family: var(--mn-font-chrome, system-ui, sans-serif);
    }

    [hidden] {
      display: none !important;
    }

    .header {
      display: flex;
      min-height: 40px;
      align-items: center;
      justify-content: space-between;
      padding: 0 var(--mn-space-3, 8px) 0 var(--mn-space-4, 12px);
      border-bottom: 1px solid var(--mn-color-border-default, #d1d5db);
      font-size: var(--mn-text-sm, 13px);
      font-weight: 650;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: var(--mn-space-2, 6px);
    }

    button {
      min-height: 28px;
      padding: 0 var(--mn-space-3, 8px);
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-radius: var(--mn-radius-control, 5px);
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-size: var(--mn-text-xs, 12px);
    }

    button:hover:not(:disabled) {
      background: var(--mn-color-surface-hover, #f3f4f6);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .end:hover:not(:disabled) {
      color: var(--mn-color-text-danger, #b42318);
    }

    .body {
      position: relative;
      min-height: 0;
      flex: 1;
    }

    /* Inset, not padded: the fit reads this box's own height and width, and
       padding would be counted as room for one more row. */
    .viewport {
      position: absolute;
      inset: var(--mn-space-2, 6px);
      overflow: hidden;
    }

    .viewport .xterm {
      height: 100%;
    }

    /* xterm paints black behind its rows by default; the strip left under
       the last whole row would show it. */
    .body,
    .viewport .xterm,
    .viewport .xterm .xterm-viewport {
      background-color: var(--mn-terminal-background, transparent) !important;
    }

    .message {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--mn-space-6, 20px);
      box-sizing: border-box;
      background: color-mix(in srgb, var(--mn-color-surface-base, #fff) 88%, transparent);
      text-align: center;
    }

    .message-content {
      max-width: 320px;
      color: var(--mn-color-text-muted, #6b7280);
      font-size: var(--mn-text-sm, 13px);
      line-height: 1.5;
    }

    .message-content strong {
      display: block;
      margin-bottom: var(--mn-space-2, 6px);
      color: var(--mn-color-text-primary, #111827);
      font-size: var(--mn-text-md, 14px);
    }

    .message-content button {
      margin-top: var(--mn-space-4, 12px);
    }

    .error {
      color: var(--mn-color-text-danger, #b42318);
    }
  `

  @property({ type: Boolean }) available = false
  @property({ type: Boolean }) enabled = false
  @property({ type: String }) status: MnTerminalStatus = 'idle'
  @property({ type: String }) error = ''
  @property({ attribute: false }) exitCode: number | null = null
  /** A CSS font-family list; empty means the app's own monospace face. */
  @property({ type: String }) fontFamily = ''
  @property({ type: Number }) fontSize = 13

  private terminal: Terminal | null = null
  private fitAddon: FitAddon | null = null
  private resizeObserver: ResizeObserver | null = null
  private styleObserver: MutationObserver | null = null
  private styleMirror: CSSStyleSheet | null = null
  private replaying = false
  /** Replay writes not yet parsed; while any is pending, xterm's own answers are dropped. */
  private replayWrites = 0
  private lastSize: MnTerminalSize = { cols: 80, rows: 24 }

  get size(): MnTerminalSize {
    return this.terminal
      ? { cols: this.terminal.cols, rows: this.terminal.rows }
      : this.lastSize
  }

  write(data: Uint8Array, replay = false): void {
    const terminal = this.ensureTerminal()
    if (!terminal) return
    if (replay && !this.replaying) terminal.reset()
    this.replaying = replay
    if (!replay) {
      terminal.write(data)
      return
    }
    // Old output holds the questions programs asked the terminal (its
    // colours, the cursor's place, what kind it is). xterm answers them
    // again as it parses them; those answers are not the person's typing.
    this.replayWrites += 1
    terminal.write(data, () => {
      this.replayWrites = Math.max(0, this.replayWrites - 1)
    })
  }

  reset(): void {
    this.replaying = false
    this.replayWrites = 0
    this.terminal?.reset()
  }

  focusTerminal(): void {
    this.terminal?.focus()
  }

  protected firstUpdated(): void {
    this.syncTerminal()
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('available') || changed.has('enabled') || changed.has('status')) {
      this.syncTerminal()
    }
    // A shell that has just gone live was opened, or reattached, at whatever
    // size this pane had before it was laid out. Tell it the real size now.
    if (changed.has('status') && this.status === 'live' && this.terminal) {
      this.fit(false)
      this.emit<MnTerminalSize>('mn-terminal-resize', this.size)
    }
    this.style.setProperty('--mn-terminal-background', this.terminalTheme().background ?? 'transparent')
    if (this.terminal) {
      this.terminal.options.theme = this.terminalTheme()
      const font = this.terminalFont()
      const size = this.terminalFontSize()
      if (this.terminal.options.fontFamily !== font || this.terminal.options.fontSize !== size) {
        this.terminal.options.fontFamily = font
        this.terminal.options.fontSize = size
        this.fit()
      }
    }
  }

  disconnectedCallback(): void {
    this.disposeTerminal()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.fitAddon?.dispose()
    this.fitAddon = null
    this.terminal?.dispose()
    this.terminal = null
    this.replaying = false
    super.disconnectedCallback()
  }

  private emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }))
  }

  private ensureTerminal(): Terminal | null {
    if (!this.available || !this.enabled) return null
    if (this.terminal) return this.terminal
    const viewport = this.renderRoot.querySelector<HTMLDivElement>('.viewport')
    if (!viewport) return null
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: this.terminalFont(),
      fontSize: this.terminalFontSize(),
      minimumContrastRatio: 4.5,
      theme: this.terminalTheme(),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.onData(data => {
      if (this.status === 'live' && this.replayWrites === 0) {
        this.emit<MnTerminalInputDetail>('mn-terminal-input', { data })
      }
    })
    terminal.open(viewport)
    this.mirrorTerminalStyles(viewport)
    this.terminal = terminal
    this.fitAddon = fitAddon
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fit())
      this.resizeObserver.observe(viewport)
    }
    this.fit(false)
    return terminal
  }

  /**
   * xterm writes its row heights, cell widths and colours into <style>
   * elements it creates at run time. The desktop app's style policy carries
   * a nonce, so the browser refuses every such element and the terminal
   * would draw without them. Their text is still readable: keep a
   * constructable sheet, which that policy does not govern, equal to it.
   */
  private mirrorTerminalStyles(viewport: HTMLElement): void {
    const root = this.renderRoot
    if (!(root instanceof ShadowRoot) || typeof CSSStyleSheet === 'undefined') return
    if (!Array.isArray(root.adoptedStyleSheets)) return
    if (!this.styleMirror) {
      this.styleMirror = new CSSStyleSheet()
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.styleMirror]
    }
    const sheet = this.styleMirror
    const copy = (): void => {
      const text = Array.from(viewport.querySelectorAll('style'), style => style.textContent ?? '').join('\n')
      sheet.replaceSync(text)
    }
    copy()
    this.styleObserver?.disconnect()
    this.styleObserver = new MutationObserver(copy)
    this.styleObserver.observe(viewport, { childList: true, characterData: true, subtree: true })
  }

  private disposeTerminal(): void {
    // A disposed terminal never calls back for writes it had not parsed.
    this.replayWrites = 0
    this.styleObserver?.disconnect()
    this.styleObserver = null
    this.styleMirror?.replaceSync('')
  }

  private syncTerminal(): void {
    if (!this.available || !this.enabled) {
      this.disposeTerminal()
      this.resizeObserver?.disconnect()
      this.resizeObserver = null
      this.fitAddon?.dispose()
      this.fitAddon = null
      this.terminal?.dispose()
      this.terminal = null
      return
    }
    this.ensureTerminal()
    if (this.status === 'live') this.fit()
  }

  private fit(emit = true): void {
    const viewport = this.renderRoot.querySelector<HTMLDivElement>('.viewport')
    if (!viewport || !this.terminal || !this.fitAddon) return
    const bounds = viewport.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    this.fitAddon.fit()
    const size = this.size
    const changed = size.cols !== this.lastSize.cols || size.rows !== this.lastSize.rows
    this.lastSize = size
    if (emit && changed && this.status === 'live') this.emit<MnTerminalSize>('mn-terminal-resize', size)
  }

  /**
   * xterm measures a cell by drawing on a canvas, and a canvas font cannot
   * be a `var()`: it would fall back to 10px sans-serif and every cell
   * would come out too wide and too short. Give it the token's value.
   */
  private terminalFontSize(): number {
    return Number.isFinite(this.fontSize) ? Math.min(32, Math.max(8, Math.round(this.fontSize))) : 13
  }

  private terminalFont(): string {
    if (this.fontFamily.trim()) return this.fontFamily
    const token = getComputedStyle(this).getPropertyValue('--mn-font-mono').trim()
    return token && !token.includes('var(') ? token : 'ui-monospace, SFMono-Regular, Menlo, monospace'
  }

  private terminalTheme(): ITheme {
    const dark = this.resolvedTheme === 'dark'
    return dark ? {
      background: '#171914',
      foreground: '#e7e4dc',
      cursor: '#b8c99a',
      selectionBackground: '#46513d',
      black: '#171914', red: '#e08a85', green: '#a8bd8a', yellow: '#d5b77e',
      blue: '#91add0', magenta: '#ba9ac8', cyan: '#86b8b0', white: '#e7e4dc',
      brightBlack: '#6f7368', brightRed: '#eda19c', brightGreen: '#bdd3a3', brightYellow: '#e3ca98',
      brightBlue: '#a9c1df', brightMagenta: '#ccb0d8', brightCyan: '#a0cbc4', brightWhite: '#faf8f1',
    } : {
      background: '#fbfaf6',
      foreground: '#282b25',
      cursor: '#42654b',
      selectionBackground: '#dce6d5',
      black: '#282b25', red: '#a34b46', green: '#476b3b', yellow: '#886b2f',
      blue: '#3f628b', magenta: '#78517f', cyan: '#386f69', white: '#f4f1e8',
      brightBlack: '#70746b', brightRed: '#bd625c', brightGreen: '#5d8250', brightYellow: '#a18240',
      brightBlue: '#547aa5', brightMagenta: '#916896', brightCyan: '#4c8880', brightWhite: '#ffffff',
    }
  }

  private open(): void {
    this.fit(false)
    this.emit<MnTerminalSize>('mn-terminal-open', this.size)
  }

  private message(): { title: string; body: string; action: boolean; error: boolean } {
    if (!this.available) return {
      title: 'Terminal is unavailable',
      body: 'The terminal is available in the Mycl desktop app.',
      action: false,
      error: false,
    }
    if (!this.enabled) return {
      title: 'Terminal is off',
      body: 'Enable Terminal in Settings → Interface, then open it here.',
      action: false,
      error: false,
    }
    if (this.status === 'opening') return { title: 'Opening your shell…', body: '', action: false, error: false }
    if (this.status === 'error') return {
      title: 'Terminal could not open',
      body: this.error || 'The native terminal returned an error.',
      action: true,
      error: true,
    }
    if (this.status === 'exited') return {
      title: 'Shell exited',
      body: this.exitCode === null ? 'Open a fresh shell when you are ready.' : `Exit code ${this.exitCode}. Open a fresh shell when you are ready.`,
      action: true,
      error: false,
    }
    return {
      title: 'Open a terminal',
      body: 'Starts your login shell in your home folder. Nothing runs until you choose Open.',
      action: true,
      error: false,
    }
  }

  protected render() {
    const message = this.message()
    const showMessage = !this.available || !this.enabled || this.status !== 'live'
    return html`
      <div class="header">
        <span>Terminal</span>
        <span class="actions">
          <button class="end" ?hidden=${this.status !== 'live'} @click=${() => this.emit('mn-terminal-end', {})}>End session</button>
        </span>
      </div>
      <div class="body">
        <div class="viewport" aria-label="Terminal output"></div>
        <div class="message" ?hidden=${!showMessage}>
          <div class="message-content">
            <strong class=${message.error ? 'error' : nothing}>${message.title}</strong>
            ${message.body}
            ${message.action ? html`<button @click=${() => this.open()}>${this.status === 'idle' ? 'Open' : 'Open a fresh shell'}</button>` : nothing}
          </div>
        </div>
      </div>
    `
  }
}
