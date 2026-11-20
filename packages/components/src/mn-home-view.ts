/**
 * Controlled Garden home surface: the life of the graph at a glance.
 *
 * Layout (Home workshop with Eschaton, 2026-10-02; first pass 2026-10-09;
 * rebalanced 2026-10-14): a top bar of pills, centered, to continue, open
 * today's note and start a document (no brand or graph name since 2026-10-15:
 * the window already says where you are), recents down the left, the newest Song
 * verse with "Remember this?" under it in the center, and "What has become
 * important" across the bottom. Nothing animates. Every section hides when it
 * has nothing to show, so a fresh graph is a calm page.
 *
 * Home sizes itself by its own width (a container query), not the window's:
 * the sidebars take part of the window. Narrower, the recents shorten and the
 * important band drops to 2x2, then 2; narrowest, it stacks, center first.
 *
 * The component owns presentation and emits intents only. Document truth,
 * activity history, daily-note creation, and persistence remain shell concerns.
 */

import { LitElement, css, html, nothing, unsafeCSS } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { SkinAware } from './skin-aware.js'
import { icon, iconStyles } from './icons.js'
import './mn-daily-note-row.js'

export interface MnHomeDocument {
  readonly graphId: string
  readonly documentId: string
  readonly title: string
  readonly timestamp?: number | null
  readonly readOnly?: boolean
  /** The folder holding it; null = unfiled; absent = not known. */
  readonly folder?: string | null
}

export interface MnHomeBlock {
  readonly documentId: string
  readonly blockId: string
  readonly documentTitle: string
  readonly text: string
  readonly importance: number
  readonly valence: number
  readonly wires: number
}

export interface MnHomeRemember {
  /** 'recent': slipping away, from the recently created. 'past': from further back. */
  readonly kind: 'recent' | 'past'
  readonly documentId: string
  readonly blockId: string
  readonly title: string
  readonly quote: string
  readonly importance: number
  /** When the document was last written (or created); null when unknown. */
  readonly timestamp: number | null
  readonly how: 'written' | 'created'
}

export interface MnHomeOpenBlockDetail {
  readonly documentId: string
  readonly blockId: string
}

export type MnHomeWelcomeDoor = 'import' | 'agent' | 'write'

export interface MnHomeWelcomeDoorDetail {
  readonly door: MnHomeWelcomeDoor
}

export interface MnHomeOpenDocumentDetail {
  readonly document: MnHomeDocument
}

export interface MnHomePinDetail extends MnHomeOpenDocumentDetail {
  readonly pinned: boolean
}

export type MnHomeStatus = 'loading' | 'ready' | 'error'

/**
 * One line of the verse. A string is the verse's own voice ('' is a stanza
 * gap); a counterpoint line names its voice, drawn as the Song document draws
 * it: 1 italic, 2 bold italic.
 */
export type MnHomeVerseLine = string | { readonly text: string; readonly voice: 1 | 2 }

function signed(value: number): string {
  const rounded = value.toFixed(1)
  return value > 0 ? `+${rounded}` : value < 0 ? `\u2212${rounded.slice(1)}` : rounded
}

function relativeTime(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
    .format(new Date(timestamp))
}

@customElement('mn-home-view')
export class MnHomeView extends SkinAware(LitElement) {
  static styles = css`
    ${unsafeCSS(iconStyles)}

    :host {
      display: block;
      height: 100%;
      overflow: hidden;
      color: var(--mn-color-text-primary, #18211b);
      background: var(--mn-color-surface-canvas, #f5f3ed);
      font-family: var(--mn-font-chrome, system-ui, sans-serif);
    }
    .home {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: var(--mn-space-10, 2.5rem) var(--mn-space-8, 2rem) var(--mn-space-16, 4rem);
      overflow-y: auto;
      user-select: none;
      background-color: var(--mn-color-surface-canvas, #f5f3ed);
      background-image: var(--mn-atmosphere, none);
      scrollbar-gutter: stable;
      container: home / inline-size;
    }
    .home-inner {
      width: 100%;
      max-width: 1180px;
      margin: 0 auto;
    }
    .top {
      display: grid;
      grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
      gap: var(--mn-space-10, 2.5rem) clamp(2rem, 5vw, 4.5rem);
      align-items: start;
    }
    .top.no-recents { grid-template-columns: minmax(0, 1fr); }
    .center {
      width: 100%;
      max-width: 560px;
      justify-self: center;
    }
    .recents { min-width: 0; }
    .recents section:first-child { margin-top: 0; }
    .recents section { margin-top: var(--mn-space-6, 1.5rem); }
    /* The verse sits in from its heading by the same step as the rows in
       the other lists (Eschaton, 2026-11-18). */
    .verse {
      margin: var(--mn-space-3, 0.75rem) 0 var(--mn-space-8, 2rem);
      padding: 0 0 0 var(--mn-space-2, 0.5rem);
      list-style: none;
      color: var(--mn-color-text-primary, #18211b);
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-size: clamp(0.9375rem, 1.2vw, 1.03125rem);
      line-height: 1.55;
      user-select: text;
    }
    .verse li {
      margin: 0 0 0.6em;
      padding-left: 1.4em;
      text-indent: -1.4em;
    }
    .verse li.stanza-gap { height: 0.6em; margin: 0; }
    /* Counterpoints, as the Song document sets them: another voice in italic,
       a third in bold italic. */
    .verse li.counterpoint { font-style: italic; }
    .verse li.counterpoint[data-voice='2'] { font-weight: 600; }
    .center > section:first-child { margin-top: 0; }
    .center .remember-section { margin-top: 0; }
    .doc-row {
      display: flex;
      align-items: center;
      gap: var(--mn-space-1, 0.25rem);
      border-bottom: 1px solid var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
      transition: background var(--mn-transition-fast, 120ms ease);
    }
    .doc-row:hover { background: var(--mn-color-neutral-100, var(--mn-color-surface-hover, #f3f7f4)); }
    .doc-open {
      flex: 1;
      width: 100%;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 0.35rem var(--mn-space-2, 0.5rem);
      border: 0;
      background: transparent;
      color: var(--mn-color-text-primary, #18211b);
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    /* Two lines, then an ellipsis. Block display, so the clamp holds inside
       the button in WebKit, where a nowrap span spilled into the Song. */
    .doc-title {
      display: -webkit-box;
      max-width: 100%;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-size: var(--mn-text-base, 0.9375rem);
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .doc-meta {
      display: flex;
      gap: 0.4rem;
      overflow: hidden;
      color: var(--mn-color-text-muted, #66736a);
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-text-xs, 0.75rem);
      white-space: nowrap;
    }
    .doc-meta .unfiled { font-style: italic; }
    .doc-row .pin { width: 32px; min-height: 32px; }
    .bottom {
      margin-top: var(--mn-space-8, 2rem);
      padding-top: var(--mn-space-6, 1.5rem);
      border-top: 1px solid var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
    }
    .bottom h3 {
      margin: 0 0 var(--mn-space-4, 1rem);
      color: var(--mn-color-text-title, var(--mn-color-text-primary, #18211b));
      font-family: var(--mn-font-display, var(--mn-font-serif, Georgia, serif));
      font-size: var(--mn-text-xl, 1.25rem);
      font-weight: 500;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--mn-space-4, 1rem);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--mn-space-3, 0.75rem);
      padding: var(--mn-space-4, 1rem) var(--mn-space-4, 1rem) var(--mn-space-3, 0.75rem);
      border: 1px solid var(--mn-color-border-subtle, #e2e0d6);
      border-radius: var(--mn-radius-lg, 8px);
      background: var(--mn-color-surface-raised, #fbfaf6);
      color: var(--mn-color-text-primary, #18211b);
      cursor: pointer;
      text-align: left;
      font: inherit;
      transition: border-color var(--mn-transition-fast, 120ms ease);
    }
    .card:hover { border-color: var(--mn-color-border-strong, #b9c9bd); }
    .card-text {
      display: -webkit-box;
      overflow: hidden;
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-size: var(--mn-text-base, 0.9375rem);
      line-height: 1.5;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 6;
    }
    .card-doc, .card-values {
      color: var(--mn-color-text-muted, #66736a);
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-text-xs, 0.75rem);
    }
    .card-values { display: flex; flex-wrap: wrap; gap: 0.25rem 0.9rem; }
    .card-values strong { color: var(--mn-color-text-secondary, #46544b); font-weight: 600; }
    /* With the Song hidden (Settings → Interface), the important cards take
       its place in the center, two across and smaller (Eschaton, 2026-11-18). */
    .center-important h2 { margin-top: 0; }
    .center-important .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--mn-space-3, 0.75rem); }
    .center-important .card { gap: var(--mn-space-2, 0.5rem); padding: var(--mn-space-3, 0.75rem); }
    .center-important .card-text { font-size: var(--mn-text-sm, 0.875rem); -webkit-line-clamp: 4; }
    .center-important + .remember-section { margin-top: var(--mn-space-6, 1.5rem); }
    .remember {
      display: flex;
      flex-direction: column;
      gap: var(--mn-space-2, 0.5rem);
      padding: var(--mn-space-4, 1rem);
      border: 0;
      border-radius: var(--mn-radius-lg, 8px);
      background: var(--mn-color-surface-accent, #eef2ec);
      color: var(--mn-color-text-primary, #18211b);
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .remembers {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--mn-space-3, 0.75rem);
    }
    .remember-kind {
      color: var(--mn-color-text-accent, #376d57);
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-text-2xs, 0.625rem);
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .remember-title {
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-size: var(--mn-text-base, 0.9375rem);
      font-weight: 600;
    }
    .remember-quote {
      display: -webkit-box;
      overflow: hidden;
      color: var(--mn-color-text-secondary, #46544b);
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-size: var(--mn-text-sm, 0.875rem);
      font-style: italic;
      line-height: 1.45;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 4;
    }
    .remember-meta {
      color: var(--mn-color-text-muted, #66736a);
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-text-xs, 0.75rem);
    }
    .card:focus-visible, .remember:focus-visible, .doc-open:focus-visible {
      outline: none;
      box-shadow: var(--mn-focus-ring, 0 0 0 2px #2d6a4f);
    }
    @container home (max-width: 980px) {
      .top {
        grid-template-columns: minmax(190px, 250px) minmax(0, 1fr);
        column-gap: var(--mn-space-8, 2rem);
      }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .rows[data-list='created'] .doc-row:nth-child(n+6),
      .rows[data-list='opened'] .doc-row:nth-child(n+5) { display: none; }
    }
    @container home (max-width: 700px) {
      .top { grid-template-columns: minmax(0, 1fr); }
      .center { order: -1; max-width: none; }
      .card:nth-child(n+3) { display: none; }
      .rows[data-list='created'] .doc-row:nth-child(n+4),
      .rows[data-list='opened'] .doc-row:nth-child(n+4) { display: none; }
    }
    @container home (max-width: 480px) {
      .cards { grid-template-columns: minmax(0, 1fr); }
    }
    /* The heading stays small so the importance band sits in the first view
       on a laptop screen: Home paces the eye, it does not ask for a scroll. */
    /* Left-aligned, on the same edge as the recents and the importance band
       below it (Eschaton, 2026-10-19: everything else on Home is left-aligned). */
    .heading {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-start;
      gap: var(--mn-space-4, 1rem) var(--mn-space-8, 2rem);
      margin-bottom: var(--mn-space-8, 2rem);
    }
    /* The page keeps a heading for screen readers; sighted readers have the
       window title. */
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: 0;
      padding: 0;
      border: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .quick {
      display: flex;
      flex: 1 1 auto;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-start;
      gap: var(--mn-space-2, 0.5rem);
      min-width: 0;
    }
    /* A pill: one line, 36px, sized to its content. Home's top-bar control. */
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      height: 36px;
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
      padding: 0 0.875rem;
      border: 1px solid var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
      border-radius: 999px;
      background: var(--mn-color-surface-raised, #fbfaf6);
      color: var(--mn-color-text-secondary, #46544b);
      cursor: pointer;
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-text-sm, 0.875rem);
      font-weight: 600;
      white-space: nowrap;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      transition:
        background var(--mn-transition-fast, 120ms ease),
        border-color var(--mn-transition-fast, 120ms ease),
        color var(--mn-transition-fast, 120ms ease);
    }
    .pill:hover {
      border-color: var(--mn-color-border-strong, #b9c9bd);
      background: var(--mn-color-surface-accent, #edf6ef);
      color: var(--mn-color-text-accent-strong, #2d6a4f);
    }
    .pill:active { background: var(--mn-color-surface-active, #e4eee7); }
    .pill .mn-icon { flex-shrink: 0; }
    .pill.resume { max-width: 340px; color: var(--mn-color-text-accent-strong, #2d6a4f); }
    .pill-kicker {
      color: var(--mn-color-text-tertiary, var(--mn-color-text-muted, #66736a));
      font-size: var(--mn-text-2xs, 0.625rem);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .pill-title {
      min-width: 0;
      overflow: hidden;
      color: var(--mn-color-text-primary, #18211b);
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-weight: 500;
      text-overflow: ellipsis;
    }
    .pill .time { color: var(--mn-color-text-muted, #66736a); font-weight: 400; }
    .state-inner {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .state-spinner {
      display: inline-flex;
      font-style: normal;
    }
    @media (prefers-reduced-motion: reduce) {
      .state-spinner .mn-icon-spin { animation: none; }
    }
    .state {
      min-height: 120px;
      display: grid;
      place-items: center;
      border-top: 1px solid var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
      border-bottom: 1px solid var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
      color: var(--mn-color-text-muted, #66736a);
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-style: italic;
      text-align: center;
    }
    .state.error { color: var(--mn-color-text-danger, #a12a2a); }
    section { width: 100%; margin-top: var(--mn-space-8, 2rem); }
    h2 {
      display: flex;
      gap: var(--mn-space-3, 0.75rem);
      align-items: center;
      margin: 0 0 var(--mn-space-2, 0.5rem);
      color: var(--mn-color-text-quiet, var(--mn-color-text-muted, #66736a));
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-text-2xs, 0.625rem);
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h2::after {
      height: 1px;
      flex: 1;
      content: '';
      background: var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--mn-space-2, 0.5rem);
      min-height: 52px;
      border-bottom: 1px solid var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
      transition: background var(--mn-transition-fast, 120ms ease);
    }
    .row:hover { background: var(--mn-color-neutral-100, var(--mn-color-surface-hover, #f3f7f4)); }
    .row:active { background: var(--mn-color-surface-active, #e4eee7); }
    .open {
      flex: 1;
      min-width: 0;
      min-height: 52px;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border: 0;
      padding: 0 var(--mn-space-2, 0.5rem);
      background: transparent;
      color: var(--mn-color-text-primary, #18211b);
      cursor: pointer;
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-size: var(--mn-text-base, 0.9375rem);
      text-align: left;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .open .mn-icon { color: var(--mn-color-text-accent, var(--mn-color-text-muted, #66736a)); flex-shrink: 0; }
    .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pin {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 44px;
      min-height: 44px;
      padding: 0;
      border: 0;
      border-radius: var(--mn-radius-control, 6px);
      background: transparent;
      color: var(--mn-color-text-muted, #66736a);
      cursor: pointer;
      opacity: 0;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      transition:
        opacity var(--mn-transition-fast, 120ms ease),
        background var(--mn-transition-fast, 120ms ease),
        color var(--mn-transition-fast, 120ms ease);
    }
    .row:hover .pin, .pin:focus-visible, .pin[aria-pressed='true'] {
      opacity: 1;
    }
    .pin:hover {
      color: var(--mn-color-text-primary, #18211b);
      background: var(--mn-color-surface-hover, #f3f7f4);
    }
    /* The first-run card: three doors, quiet, dismissible. */
    .welcome {
      position: relative;
      /* The section rule below sets width: 100%; without border-box the
         card's padding and border pushed it past the column, over the
         scroll bar. */
      box-sizing: border-box;
      margin: 0 0 var(--mn-space-6, 1.5rem);
      padding: var(--mn-space-4, 1rem);
      border: 1px solid var(--mn-color-border-subtle, #d8ded9);
      border-radius: var(--mn-radius-surface, 10px);
      background: var(--mn-color-surface-raised, #fff);
    }

    .welcome-dismiss {
      position: absolute;
      top: var(--mn-space-2, 0.5rem);
      right: var(--mn-space-2, 0.5rem);
      display: inline-flex;
      padding: 2px 8px;
      font: inherit;
      font-size: var(--mn-text-xs, 12px);
      border: 0;
      border-radius: var(--mn-radius-control, 6px);
      background: transparent;
      color: var(--mn-color-text-tertiary, #6b7280);
      cursor: pointer;
    }

    .welcome-dismiss:hover {
      background: var(--mn-color-surface-hover, #f3f4f6);
      color: var(--mn-color-text-primary, #111827);
    }

    .welcome-doors {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--mn-space-3, 0.75rem);
      padding-right: var(--mn-space-6, 1.5rem);
    }

    .welcome-door {
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-rows: auto auto;
      column-gap: var(--mn-space-2, 0.5rem);
      row-gap: 2px;
      align-items: center;
      padding: var(--mn-space-3, 0.75rem);
      border: 1px solid transparent;
      border-radius: var(--mn-radius-control, 8px);
      background: transparent;
      color: var(--mn-color-text-primary, #111827);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .welcome-door:hover,
    .welcome-door:focus-visible {
      border-color: var(--mn-color-border-subtle, #d8ded9);
      background: var(--mn-color-surface-hover, #f3f4f6);
    }

    .welcome-icon {
      display: inline-flex;
      grid-row: 1 / span 2;
      color: var(--mn-color-text-accent, #2f6b4f);
    }

    .welcome-title {
      font-weight: 600;
    }

    .welcome-note {
      grid-column: 2;
      color: var(--mn-color-text-secondary, #4b5563);
      font-size: var(--mn-text-sm, 0.875rem);
    }

    @container (max-width: 640px) {
      .welcome-doors {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    .empty {
      width: 100%;
      margin: var(--mn-space-8, 2rem) 0 0;
      padding-top: var(--mn-space-5, 1.25rem);
      border-top: 1px solid var(--mn-color-rule, var(--mn-color-border-subtle, #d8ded9));
      color: var(--mn-color-text-muted, #66736a);
      font-family: var(--mn-font-prose, var(--mn-font-serif, Georgia, serif));
      font-size: var(--mn-text-base, 0.9375rem);
      font-style: italic;
      text-align: center;
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--mn-focus-ring, 0 0 0 2px #2d6a4f);
    }
    @media (hover: none) {
      .pin { opacity: 0.68; }
    }
    @media (max-width: 620px) {
      .home { padding: var(--mn-space-7, 1.75rem) var(--mn-space-4, 1rem) var(--mn-space-10, 2.5rem); }
      .heading { margin-bottom: var(--mn-space-7, 1.75rem); }
      section { margin-top: var(--mn-space-7, 1.75rem); }
    }
  `

  @property({ type: String }) status: MnHomeStatus = 'ready'
  @property({ type: String }) error = ''
  @property({ type: String }) graphId = ''
  @property({ type: String }) graphTitle = ''
  @property({ type: String }) todayKey = ''
  @property({ attribute: false }) todayDoc: { readonly id: string; readonly updatedAt?: number } | null = null
  @property({ attribute: false }) resume: MnHomeDocument | null = null
  @property({ attribute: false }) dreamJournal: MnHomeDocument | null = null
  @property({ attribute: false }) pinned: readonly MnHomeDocument[] = []
  @property({ attribute: false }) newlyCreated: readonly MnHomeDocument[] = []
  /** The heading over the second list: "Recently created", or "Last updated" by the Interface setting. */
  @property({ attribute: false }) newlyCreatedLabel = 'Recently created'
  @property({ attribute: false }) recent: readonly MnHomeDocument[] = []
  /** The heading over `recent`. */
  @property({ attribute: false }) recentLabel = 'Recently opened'
  /** The Song is turned off in Settings: the important cards take its place. */
  @property({ type: Boolean }) songHidden = false
  /** The newest Song verse, one entry per line; empty hides it. */
  @property({ attribute: false }) verse: readonly MnHomeVerseLine[] = []
  @property({ attribute: false }) important: readonly MnHomeBlock[] = []
  /** At most one card of each kind, 'recent' first. */
  @property({ attribute: false }) remember: readonly MnHomeRemember[] = []
  /** The first-run card: three doors, shown until its Dismiss button is used. */
  @property({ type: Boolean }) welcome = false

  private emit(name: string, detail: unknown = {}): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }

  private renderWelcome() {
    if (!this.welcome) return nothing
    const door = (id: MnHomeWelcomeDoor, title: string, note: string, iconName: string) => html`<button
      type="button"
      class="welcome-door"
      data-welcome-door=${id}
      @click=${() => this.emit('mn-home-welcome-door', { door: id } satisfies MnHomeWelcomeDoorDetail)}
    >
      <span class="welcome-icon" aria-hidden="true">${icon(iconName, { size: 18 })}</span>
      <span class="welcome-title">${title}</span>
      <span class="welcome-note">${note}</span>
    </button>`
    return html`<section class="welcome" aria-label="Ways to begin">
      <button
        type="button"
        class="welcome-dismiss"
        @click=${() => this.emit('mn-home-welcome-dismiss')}
      >Dismiss</button>
      <div class="welcome-doors">
        ${door('import', 'Bring in your notes', 'Markdown, text, PDFs, EPUB, Word or notebooks, or a whole folder of them.', 'folder')}
        ${door('write', 'Quick Start', 'Open Start Here and begin.', 'file-text')}
        ${door('agent', 'Connect your agent', 'Let the agent you already use read and write here.', 'bot')}
      </div>
    </section>`
  }

  private open(document: MnHomeDocument): void {
    this.emit('mn-home-open-document', { document } satisfies MnHomeOpenDocumentDetail)
  }

  private pin(document: MnHomeDocument, pinned: boolean): void {
    this.emit('mn-home-pin-document', { document, pinned } satisfies MnHomePinDetail)
  }

  private openBlock(documentId: string, blockId: string): void {
    this.emit('mn-home-open-block', { documentId, blockId } satisfies MnHomeOpenBlockDetail)
  }

  /** A recents list: title, then folder (or unfiled) and when. */
  private renderList(label: string, list: 'pinned' | 'created' | 'opened', documents: readonly MnHomeDocument[]) {
    if (documents.length === 0) return nothing
    const pinned = list === 'pinned'
    return html`<section aria-label=${label}>
      <h2>${label}</h2>
      <div class="rows" data-list=${list}>
        ${documents.map(document => html`<div class="doc-row" data-document-id=${document.documentId}>
          <button class="doc-open" type="button" @click=${() => this.open(document)}>
            <span class="doc-title">${document.title || 'Untitled'}</span>
            <span class="doc-meta">${document.folder === null
                ? html`<span class="unfiled">unfiled</span>`
                : document.folder ? html`<span>${document.folder}</span>` : nothing}${document.folder !== undefined && document.timestamp
                ? html`<span aria-hidden="true">·</span>`
                : nothing}${document.timestamp ? html`<span>${relativeTime(document.timestamp)}</span>` : nothing}</span>
          </button>
          <button
            class="pin"
            type="button"
            aria-label=${pinned ? `Unpin ${document.title}` : `Pin ${document.title}`}
            aria-pressed=${pinned ? 'true' : 'false'}
            @click=${() => this.pin(document, !pinned)}
          >${icon(pinned ? 'x' : 'pin', { size: 14 })}</button>
        </div>`)}
      </div>
    </section>`
  }

  private renderVerse() {
    if (this.verse.length === 0) return nothing
    return html`<section class="song" aria-label="The newest verse of the Song">
      <h2>The Song · newest verse</h2>
      <ol class="verse">${this.verse.map(line => typeof line !== 'string'
        ? html`<li class="counterpoint" data-voice=${line.voice}>${line.text}</li>`
        : line
          ? html`<li>${line}</li>`
          : html`<li class="stanza-gap" aria-hidden="true"></li>`)}</ol>
    </section>`
  }

  /** "What has become important": a full-width band, 4 across when there is room. */
  private renderBottom() {
    if (this.important.length === 0 || this.songHidden) return nothing
    return html`<div class="bottom">
      <section aria-label="What has become important" style="margin-top: 0">
        <h3>What has become important</h3>
        ${this.renderCards()}
      </section>
    </div>`
  }

  /** The same cards, smaller, in the Song's place when the Song is hidden. */
  private renderCenterImportant() {
    if (this.important.length === 0 || !this.songHidden) return nothing
    return html`<section class="center-important" aria-label="What has become important">
      <h2>What has become important</h2>
      ${this.renderCards()}
    </section>`
  }

  private renderCards() {
    return html`<div class="cards">
          ${this.important.map(block => html`<button
            class="card"
            type="button"
            data-home-block=${block.blockId}
            @click=${() => this.openBlock(block.documentId, block.blockId)}
          >
            <span class="card-text">${block.text}</span>
            <span class="card-doc">${block.documentTitle}</span>
            <span class="card-values">
              <span>importance <strong>${block.importance.toFixed(1)}</strong></span>
              <span>valence <strong>${signed(block.valence)}</strong></span>
              <span>wires <strong>${block.wires}</strong></span>
            </span>
          </button>`)}
        </div>`
  }

  /** "Remember this?": under the verse, side by side when the center has room. */
  private renderRemember() {
    if (this.remember.length === 0) return nothing
    return html`<section class="remember-section" aria-label="Remember this?">
      <h2>Remember this?</h2>
      <div class="remembers">
        ${this.remember.map(item => html`<button
          class="remember"
          type="button"
          data-home-remember=${item.documentId}
          data-remember-kind=${item.kind}
          @click=${() => this.openBlock(item.documentId, item.blockId)}
        >
          <span class="remember-kind">${item.kind === 'recent' ? 'Slipping away' : 'From further back'}</span>
          <span class="remember-title">${item.title}</span>
          <span class="remember-quote">\u201c${item.quote}\u201d</span>
          <span class="remember-meta">${item.timestamp !== null ? `${item.how} ${relativeTime(item.timestamp)} · ` : ''}importance ${item.importance.toFixed(1)}</span>
        </button>`)}
      </div>
    </section>`
  }

  /**
   * The top row: continue, today's note, a new document, and last, only when
   * last night's dreams are in, the Dream Journal.
   */
  private renderQuick() {
    return html`<div class="quick" role="group" aria-label="Start here">
      ${this.resume ? html`<button
        class="pill resume"
        type="button"
        aria-label=${`Continue writing ${this.resume.title || 'Untitled'}`}
        @click=${() => this.open(this.resume!)}
      >
        ${icon('arrow-left', { size: 14 })}
        <span class="pill-kicker">Continue</span>
        <span class="pill-title">${this.resume.title || 'Untitled'}</span>
      </button>` : nothing}
      ${this.todayKey ? html`<mn-daily-note-row
        compact
        displayed-date=${this.todayKey}
        today-key=${this.todayKey}
        .doc=${this.todayDoc}
      ></mn-daily-note-row>` : nothing}
      <button class="pill new-document" type="button" @click=${() => this.emit('mn-home-new-document')}>
        ${icon('file-plus-corner', { size: 14 })}<span>New document</span>
      </button>
      ${this.dreamJournal ? html`<button class="pill dream" type="button" @click=${() => this.open(this.dreamJournal!)}>
        ${icon('moon', { size: 14 })}<span>Dream Journal</span>
        ${this.dreamJournal.timestamp ? html`<span class="time">${relativeTime(this.dreamJournal.timestamp)}</span>` : nothing}
      </button>` : nothing}
    </div>`
  }

  render() {
    const hasDocuments = this.pinned.length + this.newlyCreated.length + this.recent.length > 0
    return html`<main class="home" aria-label="Mycl home">
      <div class="home-inner">
        <header class="heading">
          <h1 class="visually-hidden">${this.graphTitle || this.graphId || 'Mycl'}</h1>
          ${this.status === 'ready' ? this.renderQuick() : nothing}
        </header>

        ${this.status === 'loading'
          ? html`<div class="state" role="status" aria-busy="true"><span class="state-inner"><span class="state-spinner" aria-hidden="true">${icon('loader-circle', { size: 16, class: 'mn-icon-spin' })}</span>Gathering this graph…</span></div>`
          : this.status === 'error'
            ? html`<div class="state error" role="alert">${this.error || 'This graph’s documents are unavailable.'}</div>`
            : html`<div class="ready">
              ${this.renderWelcome()}
              <div class=${hasDocuments ? 'top' : 'top no-recents'}>
                ${hasDocuments ? html`<aside class="recents" aria-label="Recently">
                  ${this.renderList('Pinned', 'pinned', this.pinned)}
                  ${this.renderList(this.newlyCreatedLabel, 'created', this.newlyCreated)}
                  ${this.renderList(this.recentLabel, 'opened', this.recent)}
                </aside>` : nothing}
                <div class="center">
                  ${this.songHidden ? this.renderCenterImportant() : this.renderVerse()}
                  ${this.renderRemember()}
                  ${!hasDocuments ? html`<p class="empty">Your first pages will gather here.</p>` : nothing}
                </div>
              </div>
              ${this.renderBottom()}
            </div>`}
      </div>
    </main>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-home-view': MnHomeView
  }
}
