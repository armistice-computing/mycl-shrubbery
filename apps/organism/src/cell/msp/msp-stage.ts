/**
 * msp-stage.ts — the meta-spread stage, live-data edition (2026-09-30, Zeta).
 *
 * A full prototype of the meta-spread design (graph doc "Meta-Spread — a
 * wire-centric visual primitive (design seed, 2026-09-28)") running against a
 * REAL graph through an injected adapter. The shell (apps/organism) owns the
 * adapter; this element owns only presentation + interaction state.
 *
 * Two surfaces, one idiom:
 *   - TRAVERSE (Cmd+Opt+;): devoted full-screen topological reading. Doc card
 *     as the first block, primaries = the doc's wired blocks in document
 *     order, incoming stacks left / outgoing right. Hover a primary for full
 *     text + above/below context; hover a secondary for the full block.
 *     Click a secondary to FOLLOW its wire: the camera pans (outgoing →
 *     right, incoming → left), and the place you came from keeps its
 *     emphasis in place — the origin card glows and clicking it rewinds one
 *     step. Click a primary to exit into the editor at that block. The walk
 *     is a walk: loops unroll, rewind truncates.
 *   - CREATE (Cmd+Shift+; — shadows the advanced wire menu in this build):
 *     origin | find | target columns. Doc-as-folder browsing, emphasized
 *     search (lexical via the adapter), dashed semantic candidates
 *     (proximity offered, never predicates). Direction flip. The predicate
 *     ring (relatesTo central, scroll to cycle, click-away = neutral). The
 *     forming arc between the two ends, the settling fan, the drop-back —
 *     the editor was never unmounted.
 *
 * Wire creation is REAL: commits go through the adapter to the cell's
 * create_wires path (workspace CRDT op), so panels and bubbles update by
 * ordinary sync.
 */

import { LitElement, css, html, svg, nothing, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'

// ── Adapter surface (the shell injects this) ────────────────────────────────

export interface MspBlock {
  readonly id: string
  readonly text: string
  /** TipTap node type ('Paragraph', 'Heading', …) for the role band. */
  readonly type?: string
  /** Heading level when type is 'Heading'. */
  readonly level?: number
}

export interface MspWire {
  readonly id: string
  readonly predicate: string
  readonly predicateLabel: string
  readonly direction: 'out' | 'in'
  readonly otherDocId: string
  readonly otherBlockId: string | null
  readonly otherSnippet: string
  readonly otherTitle: string
  readonly bidirectional: boolean
}

export interface MspLaneData {
  readonly docId: string
  readonly title: string
  /** All blocks in document order. */
  readonly blocks: readonly MspBlock[]
  /** Doc-level wires (no local block). */
  readonly docWires: readonly MspWire[]
  /** Per-block wires keyed by LOCAL block id. */
  readonly blockWires: ReadonlyMap<string, readonly MspWire[]>
  /** Wired block ids in document order (primaries). */
  readonly primaries: readonly string[]
}

export interface MspSearchHit {
  readonly docId: string
  readonly docTitle: string
  readonly blockId: string
  readonly text: string
  readonly kind: 'lexical' | 'candidate'
}

export interface MspWireCommit {
  readonly sourceDocId: string
  readonly sourceBlockId: string | null
  readonly targetDocId: string
  readonly targetBlockId: string | null
  readonly predicate: string
}

export interface MspAdapter {
  loadLane(docId: string): Promise<MspLaneData>
  loadBlocks(docId: string): Promise<readonly MspBlock[]>
  searchBlocks(query: string): Promise<readonly MspSearchHit[]>
  loadCandidates(originDocId: string, originText: string): Promise<readonly MspSearchHit[]>
  createWire(input: MspWireCommit): Promise<void>
  listDocs(): readonly { readonly id: string; readonly title: string }[]
  docTitle(docId: string): string
}

// ── Walk state ──────────────────────────────────────────────────────────────

interface TrailStep {
  readonly id: number
  readonly docId: string
  readonly arrivedBy: 'out' | 'in' | null
  readonly departedDir: 'out' | 'in' | null
  readonly viaPredicate: string | null
  readonly arriveAtBlockId: string | null
  /** Set when an outside surface (the wire atlas) hands off with a known
   * origin but no walk step exists to name it. */
  readonly fromDocTitle?: string | null
}

/** Arrival context for the atlas handoff (Epsilon, 2026-10-15): land on a
 * document with the same chrome a wire-follow produces — the arrival glow and
 * the "came from" tag — without faking a trail step. */
export interface MspArrival {
  readonly arriveAtBlockId?: string | null
  readonly viaPredicate?: string | null
  readonly fromDocTitle?: string | null
  /** The wire's direction from the origin's side; drives which edge the
   * origin emphasis leans toward. */
  readonly direction?: 'out' | 'in' | null
}

const PAN_MS = 340
const TIMINGS = { arc: 300, settle: 380, home: 950 }

@customElement('msp-live-stage')
export class MspLiveStage extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--mn-font-chrome, system-ui, sans-serif);
      color: var(--mn-color-text-primary, #1f2937);
    }
    * { box-sizing: border-box; }
    :host(:not([data-open='true'])) { display: none; }

    .veil {
      position: fixed;
      inset: 0;
      z-index: 9000;
      /* Darker and blurrier (her read 2026-10-09): the compressed text was
         muddy against the editor showing through. */
      background: var(--mn-color-backdrop, rgba(10, 10, 16, 0.72));
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      animation: veil-in 220ms ease-out;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: opacity 300ms ease, transform 300ms ease;
    }
    .veil.leaving { opacity: 0; transform: translateY(26px); pointer-events: none; }
    @keyframes veil-in { from { opacity: 0; } to { opacity: 1; } }
    .stage-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 20px; color: #f4f4f6; font-size: 0.8rem; flex: 0 0 auto;
    }
    .stage-head .mode-pill {
      font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--mn-color-accent, #9aa8ff); border: 1px solid currentColor;
      border-radius: 999px; padding: 3px 10px; margin-right: 10px;
    }
    .stage-head .docname { font-weight: 600; }
    .stage-head .keys { opacity: 0.55; font-size: 0.72rem; }
    button.bar {
      font: inherit; font-size: 0.78rem; padding: 6px 12px; border-radius: 8px;
      border: 1px solid var(--mn-color-border, rgba(0,0,0,0.14));
      background: var(--mn-color-paper, #fff); cursor: pointer;
    }
    button.bar:hover { border-color: var(--mn-color-accent, #6a7fdb); }

    /* cards — translucent at rest so they share the text field's weather,
       opaque on hover/focal (her cohesion note, 2026-10-09). */
    .card {
      background: color-mix(in srgb, var(--mn-color-paper, #fff) 82%, transparent);
      border: 1px solid var(--mn-color-border, rgba(0,0,0,0.08));
      border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0,0,0,0.28);
      padding: 8px 12px;
      font-size: 0.8rem;
      line-height: 1.5;
      transition: opacity 160ms ease, transform 160ms ease, box-shadow 160ms ease, background 160ms ease;
      cursor: pointer;
    }
    .card:hover, .row.focal .card, .card.hovered {
      background: var(--mn-color-paper, #fff);
    }
    /* The doc card is dark-on-dark by design; the paper hover would make its
       light text unreadable (her catch, 2026-10-14). */
    .card.doc-card:hover, .row.focal .card.doc-card {
      background: var(--mn-color-text-primary, #1f2937);
    }
    .card .doc-tag {
      font-size: 0.6rem; font-weight: 700; letter-spacing: 0.1em;
      text-transform: uppercase; opacity: 0.8; margin-bottom: 4px;
      color: var(--mn-color-text-secondary, #374151);
    }
    /* A document-level wire's name reads at full weight, like block text. */
    .card.docwire .doc-tag { opacity: 1; color: var(--mn-color-text-primary, #1f2937); }
    .card .pred {
      display: block; margin-top: 6px; font-size: 0.64rem; font-weight: 600;
      color: var(--mn-color-accent, #6a7fdb);
    }
    .card.doc-card {
      background: var(--mn-color-text-primary, #1f2937);
      color: var(--mn-color-paper, #fff);
      font-weight: 600; text-align: center; cursor: default;
    }
    .card.doc-card .doc-tag { color: inherit; opacity: 0.6; }
    .card.candidate {
      background: color-mix(in srgb, var(--mn-color-paper, #fff) 22%, transparent);
      border: 1.5px dashed var(--mn-color-border-strong, rgba(255,255,255,0.4));
      color: var(--mn-color-text-primary, #1f2937);
      box-shadow: none;
    }
    .card.candidate .doc-tag { opacity: 0.75; }

    /* traversal */
    .viewport { position: relative; flex: 1 1 auto; overflow: hidden; }
    .lane {
      position: absolute; top: 0; bottom: 0; left: 0; width: 100%;
      overflow-y: auto; padding: 8px 20px 64px;
      transition: transform ${PAN_MS}ms cubic-bezier(0.32, 0.72, 0.24, 1), opacity ${PAN_MS}ms ease;
    }
    .lane.behind-left { transform: translateX(-100%); }
    .lane.behind-right { transform: translateX(100%); }
    .lane.fading-in .card { animation: card-in 300ms ease both; }
    @keyframes card-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }
    .lane-loading {
      max-width: 480px; margin: 18vh auto 0; text-align: center;
      color: rgba(255,255,255,0.75); font-size: 0.85rem;
    }
    .rows { max-width: 1180px; margin: 0 auto; }
    /* A real grid: the two wire columns are fixed and the gaps are equal by
       construction. (The flex+auto-margin version drifted — the scrollbar
       shifted every row left, so the right stack sat closer to the card.) */
    .row {
      display: grid;
      grid-template-columns: 300px minmax(0, 380px) 300px;
      justify-content: center;
      column-gap: 48px;
      align-items: start;
      margin-bottom: 10px;
      position: relative;
    }
    .row.compact { display: block; }
    .stack { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .stack .card { font-size: 0.72rem; padding: 8px 10px; }
    /* Primaries render FULL text by default (her 2026-10-09 ruling: wired
       blocks should not need hover to be read); context comes from the
       neighbor emphasis below, not duplicated above/below rows. */
    .primary-card { position: relative; }
    .row.focal .primary-card {
      transform: scale(1.015);
      box-shadow: 0 20px 48px rgba(0,0,0,0.4);
      border-color: var(--mn-color-accent, #6a7fdb);
    }
    .lane[data-hovering='true'] .card { opacity: 0.38; transform: scale(0.985); }
    .lane[data-hovering='true'] .row.focal .card,
    .lane[data-hovering='true'] .card.hovered { opacity: 1; transform: none; }

    /* Neighbor emphasis (her 2026-10-09: hover any block and the blocks above
       and below lean in slightly — context without duplicated rows). Works
       across compact↔primary boundaries. */
    .row:hover + .row.compact .compact-text,
    .row:has(+ .row:hover).compact .compact-text { opacity: 0.72; }
    .row:hover + .row:not(.compact) .primary-card,
    .row:has(+ .row:hover):not(.compact) .primary-card {
      border-color: var(--mn-color-border-strong, rgba(255,255,255,0.35));
      box-shadow: 0 12px 30px rgba(0,0,0,0.34);
    }

    /* The compressed reading surface (2026-10-09): every unwired block renders
       small and quiet between the wired cards. Hover expands in place — the
       top edge never moves, reflow only goes downward, so the pointer's
       target is stable. Heading role bands survive compression. Round 2: a
       faint card chrome on every block, so the field reads as one material;
       brighter text on a darker veil. */
    .row.compact { padding: 0; margin-bottom: 2px; }
    .row.compact .compact-text {
      max-width: 380px;
      margin: 0 auto;
      padding: 2px 10px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.045);
      font-size: 0.78rem;
      line-height: 1.4;
      /* The veil is a DARK overlay (stage-head text is #f4f4f6) — light text,
         not the editor's light-theme tokens, or the rows vanish into it. */
      color: #f4f4f6;
      opacity: 0.8;
      cursor: pointer;
      transition: opacity 120ms ease, font-size 120ms ease, background 120ms ease;
    }
    /* Expand less (her revision, 2026-10-14): a nudge, not a bloom. */
    .row.compact:hover .compact-text {
      font-size: 0.86rem;
      opacity: 1;
      background: rgba(255, 255, 255, 0.09);
    }
    .row.compact.h1 .compact-text { font-size: 0.88rem; font-weight: 650; opacity: 0.74; }
    .row.compact.h2 .compact-text { font-size: 0.84rem; font-weight: 600; opacity: 0.7; }
    .row.compact.h3 .compact-text { font-size: 0.81rem; font-weight: 600; opacity: 0.66; }
    .row.compact.h1:hover .compact-text { font-size: 1.02rem; }
    .row.compact.h2:hover .compact-text { font-size: 0.95rem; }
    .row.compact.h3:hover .compact-text { font-size: 0.9rem; }
    .lane[data-hovering='true'] .compact-text { opacity: 0.4; }
    .lane[data-hovering='true'] .row.compact:hover .compact-text { opacity: 1; }

    /* Connector lines: painted under the cards, between a block and its
       wires. svg sits first in the lane so rows (position: relative) paint
       over it. */
    .links { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; overflow: visible; }
    .links path {
      fill: none;
      stroke: var(--mn-color-accent, #9aa8ff);
      stroke-width: 1.5;
      opacity: 0.55;
    }

    /* Scroll hints (2026-10-16, her last 1.0 ask): "N wired above/below",
       fixed to the viewport, quiet, clickable jumps. */
    .scroll-hint {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2;
      padding: 3px 12px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 999px;
      background: rgba(12, 12, 18, 0.72);
      backdrop-filter: blur(6px);
      color: rgba(244, 244, 246, 0.82);
      font-size: 0.66rem;
      cursor: pointer;
      user-select: none;
    }
    .scroll-hint:hover { color: #fff; border-color: var(--mn-color-accent, #9aa8ff); }
    .scroll-hint.up { top: 6px; }
    .scroll-hint.down { bottom: 10px; }

    /* Second-order fan: mini cards on the far outside edge (left stack fans
       further left, right further right — outward, fractal). Readable, so it
       takes pointer events; leaving it dismisses it. */
    .tertiary {
      position: absolute; top: 0; z-index: 1;
      display: flex; flex-direction: column; gap: 6px;
      width: 180px;
    }
    /* left/right positioning is computed per-hover in _positionTertiary
       (the stack's outer edge), not pinned to the lane edge. */
    .mini-card {
      cursor: pointer;
      background: color-mix(in srgb, var(--mn-color-paper, #fff) 88%, transparent);
      border: 1px solid var(--mn-color-border, rgba(0,0,0,0.08));
      border-radius: 8px;
      padding: 5px 8px;
      font-size: 0.62rem;
      line-height: 1.35;
      box-shadow: 0 6px 16px rgba(0,0,0,0.22);
    }
    .mini-card .doc-tag {
      font-size: 0.55rem;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .mini-card .pred { display: block; margin-top: 2px; font-size: 0.56rem; }
    .mini-card.more { opacity: 0.7; font-style: italic; text-align: center; }
    .mini-card.extra { display: none; }
    .tertiary:has(.mini-card.more:hover) .mini-card.extra { display: block; }
    .mini-card:not(.more):hover { background: var(--mn-color-paper, #fff); border-color: var(--mn-color-accent, #6a7fdb); }

    /* Width tiers (her 2026-10-14): narrower windows shrink the wire zones;
       below ~980px the tertiary fan goes away entirely. */
    @media (max-width: 1240px) {
      .row { grid-template-columns: 232px minmax(0, 330px) 232px; column-gap: 32px; }
      .stack { width: 232px; }
      .row.compact .compact-text { max-width: 330px; }
      .card { font-size: 0.76rem; }
    }
    @media (max-width: 980px) {
      .tertiary { display: none; }
      .row { grid-template-columns: 190px minmax(0, 300px) 190px; column-gap: 20px; }
      .stack { width: 190px; }
      .row.compact .compact-text { max-width: 300px; }
    }

    /* Document-level wires (2026-10-09): compact chips hugging the doc card —
       title + predicate only, incoming slightly left / outgoing slightly
       right, closer to center than the block stacks. No first-block preview
       at rest; hover still expands to the preview. Groups collapse by
       predicate and unfurl on hover (the 1398px stack fix). */
    /* The docrow uses the SAME fixed columns and gaps as the block rows, so
       doc-level and block-level wires share one vertical seam at any title
       length (her short-title catch, 2026-10-16). The center auto column
       flexes with the title. */
    .row.docrow { display: grid; grid-template-columns: 300px minmax(0, 380px) 300px; justify-content: center; column-gap: 48px; margin-bottom: 14px; }
    .row.docrow .stack { width: auto; max-width: 300px; }
    /* At any title length the chips hug the OUTER edge of their column, so
       doc-level and block-level outgoing wires share one vertical seam (her
       short-title catch, 2026-10-16). */
    .row.docrow > .stack:first-child { justify-self: start; }
    .row.docrow > .stack:last-child { justify-self: end; }
    .row.docrow .doc-card { flex: 0 1 auto; }
    .docgroup .members { display: none; flex-direction: column; gap: 8px; margin-top: 8px; }
    .docgroup:hover .members { display: flex; }
    /* Unfurl follows the stack and the cone's side: resting on the owner
       card unfurls both; coning out to one side unfurls only that side
       (her 2026-10-14: "going in on the right shouldn't unfurl the left"). */
    .row .stack.unfurl .docgroup .members { display: flex; }
    /* …and while a member or its fan is hovered (regardless of side). */
    .docgroup.keep .members { display: flex; }
    .docgroup .group-chip { text-align: center; cursor: default; }
    .docgroup .group-chip .pred { color: var(--mn-color-text-muted, #6b7280); }
    /* Doc-level chips stay chips: one line of title, tight padding. */
    .card.docwire { padding: 6px 10px; }
    .card.docwire .doc-tag {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 240px; margin-bottom: 2px;
    }
    .row .card.arrival { animation: arrive 900ms ease-out; }
    @keyframes arrive {
      0% { box-shadow: 0 0 0 0 var(--mn-color-accent, #6a7fdb); }
      60% { box-shadow: 0 0 0 12px transparent; }
      100% { box-shadow: 0 10px 28px rgba(0,0,0,0.28); }
    }
    .ctx {
      font-size: 0.72rem; font-style: italic; opacity: 0.6;
      padding: 6px 2px 0; margin-top: 6px; border-top: 1px dashed rgba(0,0,0,0.1);
    }
    .ctx.above { border-top: none; border-bottom: 1px dashed rgba(0,0,0,0.1); padding: 0 2px 6px; margin: 0 0 6px; }
    .card .full { font-size: 0.78rem; line-height: 1.5; }
    .row.origin .primary-card {
      border-color: var(--mn-color-accent, #6a7fdb);
      box-shadow: 0 0 0 1.5px var(--mn-color-accent, #6a7fdb), 0 14px 34px rgba(0,0,0,0.32);
      cursor: pointer;
    }

    /* creation */
    .create-grid {
      flex: 1 1 auto; display: grid; grid-template-columns: 1fr 1.35fr 1fr;
      gap: 22px; padding: 10px 28px 40px; min-height: 0;
    }
    .ccol { overflow-y: auto; min-height: 0; }
    .ccol-title {
      font-size: 0.64rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: rgba(255,255,255,0.6); margin: 4px 2px 12px;
    }
    .ccol .card { margin-bottom: 12px; }
    .ccol .card.dim { opacity: 0.35; cursor: default; }
    .find-search {
      width: 100%; font: inherit; font-size: 0.8rem; padding: 9px 12px;
      border-radius: 8px; border: 1.5px solid var(--mn-color-accent, #6a7fdb);
      background: var(--mn-color-paper, #fff); color: inherit; margin-bottom: 14px; outline: none;
    }
    .find-search:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--mn-color-accent, #6a7fdb) 25%, transparent); }
    .find-doc {
      padding: 9px 12px; border-radius: 8px; font-size: 0.8rem; font-weight: 600;
      color: #f0f0f4; cursor: pointer; border: 1px solid transparent;
      display: flex; justify-content: space-between; align-items: center;
    }
    .find-doc:hover, .find-doc.open { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.16); }
    .find-doc .chev { opacity: 0.5; }
    .find-doc .row-actions { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; }
    .find-doc .chevbtn {
      font: inherit; font-size: 0.8rem; background: transparent; border: none;
      color: rgba(255,255,255,0.6); cursor: pointer; padding: 2px 6px;
    }
    .find-doc .chevbtn:hover { color: #fff; }
    .find-blocks { margin: 4px 0 16px 14px; border-left: 2px solid rgba(255,255,255,0.14); padding-left: 10px; }
    .find-block {
      background: var(--mn-color-paper, #fff); border-radius: 8px; padding: 8px 10px;
      font-size: 0.72rem; line-height: 1.45; margin-bottom: 8px; cursor: pointer;
      border: 1px solid var(--mn-color-border, rgba(0,0,0,0.08));
      transition: transform 130ms ease, box-shadow 130ms ease;
      display: flex; gap: 8px; align-items: flex-start; justify-content: space-between;
    }
    .find-block:hover { transform: scale(1.02); box-shadow: 0 8px 20px rgba(0,0,0,0.3); }
    .find-block.picked { outline: 2px solid var(--mn-color-accent, #6a7fdb); }
    .find-block .wirebtn {
      flex: 0 0 auto; font-size: 0.62rem; font-weight: 700;
      color: var(--mn-color-accent, #6a7fdb); border: 1px solid currentColor;
      border-radius: 999px; padding: 2px 8px; background: transparent; cursor: pointer;
    }
    .cand-head {
      font-size: 0.6rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
      color: rgba(255,255,255,0.45); margin: 2px 0 8px 14px;
    }
    .cand-head .dashnote { font-weight: 400; text-transform: none; letter-spacing: 0; opacity: 0.8; }
    .cand-mini { font-size: 0.62rem; padding: 6px 8px; opacity: 0.72; }
    .cand-mini:hover { opacity: 1; }
    .result-doc {
      font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.1em; color: rgba(255,255,255,0.5); margin: 12px 0 6px;
    }
    .target-empty { color: rgba(255,255,255,0.5); font-size: 0.78rem; font-style: italic; padding: 12px 4px; }
    .target-col .card { cursor: default; }
    .commit-row { margin-top: 8px; text-align: center; }
    button.commit {
      font: inherit; font-size: 0.82rem; font-weight: 700; padding: 9px 22px;
      border-radius: 999px; border: none; background: var(--mn-color-accent, #6a7fdb);
      color: var(--mn-color-on-accent, #fff); cursor: pointer;
      box-shadow: 0 8px 22px rgba(0,0,0,0.35);
    }
    button.commit:hover { filter: brightness(1.08); }
    /* crafting moment: the pair comes to center, the ring blooms between */
    .craft-stage {
      position: relative;
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 48px;
      padding: 0 64px;
    }
    .craft-col { width: 340px; flex: 0 0 auto; animation: craft-in 260ms cubic-bezier(0.34, 1.36, 0.64, 1) both; }
    .craft-col:last-of-type { animation-delay: 90ms; }
    @keyframes craft-in {
      from { opacity: 0; transform: translateY(14px) scale(0.94); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .craft-back { position: absolute; top: 18px; left: 22px; }
    .craft-flip { flex: 0 0 auto; font-size: 1rem; padding: 8px 12px; border-radius: 50%; }
    .craft-reopen {
      position: absolute;
      bottom: 15%;
      left: 50%;
      transform: translateX(-50%);
      font: inherit;
      font-size: 0.74rem;
      font-weight: 600;
      padding: 8px 18px;
      border-radius: 999px;
      background: var(--mn-color-paper, #fff);
      border: 1.5px solid var(--mn-color-accent, #6a7fdb);
      color: var(--mn-color-accent, #6a7fdb);
      cursor: pointer;
      animation: veil-in 200ms ease 200ms both;
    }
    .dir-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px; font-size: 0.7rem; color: rgba(255,255,255,0.78);
    }
    .dir-map { font-weight: 600; }
    .flip {
      font: inherit; font-size: 0.66rem; font-weight: 700; padding: 3px 10px;
      border-radius: 999px; background: transparent;
      border: 1px solid var(--mn-color-accent, #9aa8ff);
      color: var(--mn-color-accent, #9aa8ff); cursor: pointer;
    }
    .flip:hover { background: color-mix(in srgb, var(--mn-color-accent, #9aa8ff) 18%, transparent); }

    svg.arc-layer { position: absolute; inset: 0; pointer-events: none; z-index: 8; overflow: visible; }
    svg.arc-layer path.forming {
      fill: none; stroke: var(--mn-color-accent, #9aa8ff); stroke-width: 2.5;
      stroke-linecap: round; filter: drop-shadow(0 0 6px var(--mn-color-accent, #9aa8ff));
    }
    .arc-label {
      position: absolute; transform: translate(-50%, -50%);
      background: var(--mn-color-text-primary, #1f2937); color: var(--mn-color-paper, #fff);
      font-size: 0.68rem; font-weight: 700; padding: 4px 12px; border-radius: 999px; z-index: 9;
      animation: veil-in 200ms ease 200ms both;
    }
    .settle-chip {
      position: absolute; width: 168px; background: var(--mn-color-paper, #fff);
      border-radius: 8px; padding: 7px 9px; font-size: 0.64rem; line-height: 1.4;
      box-shadow: 0 8px 22px rgba(0,0,0,0.35); z-index: 9; opacity: 0;
      animation: chip-in 260ms cubic-bezier(0.34, 1.36, 0.64, 1) forwards;
    }
    @keyframes chip-in {
      from { opacity: 0; transform: translateX(-10px) scale(0.9); }
      to { opacity: 1; transform: translateX(0) scale(1); }
    }

    .ring-backdrop { position: fixed; inset: 0; z-index: 9059; }
    .ring-wrap { position: fixed; z-index: 9060; width: 0; height: 0; }
    .ring-center {
      position: absolute; left: -46px; top: -46px; width: 92px; height: 92px;
      border-radius: 50%; background: var(--mn-color-paper, #fff);
      border: 2px solid var(--mn-color-accent, #6a7fdb);
      color: var(--mn-color-text-primary, #1f2937);
      font-size: 0.68rem; font-weight: 700;
      display: flex; align-items: center; justify-content: center; text-align: center;
      cursor: pointer; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      animation: ring-in 180ms cubic-bezier(0.34, 1.36, 0.64, 1);
    }
    @keyframes ring-in { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .ring-item {
      position: absolute; width: 86px; margin-left: -43px; margin-top: -13px;
      text-align: center; font-size: 0.64rem; font-weight: 600; padding: 4px 0;
      border-radius: 999px; background: var(--mn-color-paper, #fff);
      border: 1px solid var(--mn-color-border, rgba(0,0,0,0.12));
      color: var(--mn-color-text-primary, #1f2937); cursor: pointer;
      transition: transform 120ms ease;
      animation: ring-in 200ms cubic-bezier(0.34, 1.36, 0.64, 1) both;
    }
    .ring-item.sel { background: var(--mn-color-accent, #6a7fdb); color: var(--mn-color-on-accent, #fff); }
    .ring-hint {
      position: absolute; top: 56px; left: -110px; width: 220px; text-align: center;
      color: rgba(255,255,255,0.75); font-size: 0.64rem;
    }
    .create-note { font-size: 0.64rem; color: rgba(255,255,255,0.5); text-align: center; margin-top: 10px; }
  `

  /** Injected by the shell before first open. */
  @property({ attribute: false }) adapter!: MspAdapter

  @state() private _view: 'closed' | 'traverse' | 'create' = 'closed'
  @state() private _leaving = false

  // traversal
  @state() private _walk: TrailStep[] = []
  @state() private _hoveredId: string | null = null
  @state() private _arrivalKey: string | null = null
  @state() private _showPrev = false
  @state() private _panPhase: 'idle' | 'start' | 'settle' = 'idle'
  @state() private _lanes: ReadonlyMap<string, MspLaneData | 'loading' | 'error'> = new Map()
  @state() private _blocks: ReadonlyMap<string, readonly MspBlock[]> = new Map()
  private _nextStepId = 1
  private _panDir: 'out' | 'in' = 'out'
  private _loadToken = 0

  // creation
  @state() private _originDocId = ''
  @state() private _originBlockId: string | null = null
  @state() private _findDocId: string | null = null
  @state() private _findBlocks: ReadonlyMap<string, readonly MspBlock[]> = new Map()
  @state() private _target: { docId: string; blockId: string | null } | null = null
  @state() private _phase: 'find' | 'craft' = 'find'
  @state() private _direction: 'out' | 'in' = 'out'
  @state() private _query = ''
  @state() private _searchHits: readonly MspSearchHit[] = []
  @state() private _searching = false
  @state() private _candidates: readonly MspSearchHit[] = []
  @state() private _ring: { x: number; y: number; sel: number } | null = null
  @state() private _forming: { d: string; lx: number; ly: number; label: string; len: number } | null = null
  @state() private _settling = false
  @state() private _writing = false

  private _timers: number[] = []
  private _searchSeq = 0

  private _keydown = (e: KeyboardEvent) => {
    if (this._view === 'closed') return
    // Swallow the shell dialogs' shortcuts while the veil is up (they opened
    // BELOW it otherwise) — focus belongs to the stage.
    if ((e.metaKey || e.ctrlKey) && ['t', 'k', 'n'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      // Esc dismisses the ring WITHOUT writing; click-away is the neutral
      // commit. A second Esc closes the overlay.
      if (this._ring) { this._ring = null; return }
      this._goHome()
    }
  }

  connectedCallback() {
    super.connectedCallback()
    // A custom element must be focusable or focus() is a no-op and the
    // editor keeps the caret (Delta's blocker 1, first re-review).
    this.tabIndex = -1
    document.addEventListener('keydown', this._keydown, true)
  }
  disconnectedCallback() {
    document.removeEventListener('keydown', this._keydown, true)
    this._timers.forEach(t => clearTimeout(t))
    super.disconnectedCallback()
  }
  private _later(fn: () => void, ms: number) {
    this._timers.push(window.setTimeout(fn, ms))
  }

  protected updated(_changed: PropertyValues): void {
    if (_changed.has('_view') && _changed.get('_view') === 'closed' && this._view !== 'closed') {
      this.setAttribute('data-open', 'true')
      this.dispatchEvent(new CustomEvent('msp-open', { bubbles: true, composed: true }))
      // Focus a REAL button inside the stage (the host element's own focus()
      // is a no-op in this environment; a button accepts it, and the editor
      // loses the caret). This is what keeps typing out of the document.
      // Focus the LANE, not the Close button: Space and the arrows scroll
      // the reading surface instead of closing it (Delta's follow-up).
      this.renderRoot.querySelector<HTMLElement>('.lane[data-current=\'true\']')?.focus({ preventScroll: true })
    }
    if (this._view === 'traverse') {
      this._scheduleLinks()
      this._positionTertiary()
      this._scrollToArrival()
      this._syncGroupKeep()
      if (this._current) this._updateScrollHints(this._current)
    }
  }

  /** Once per arrival: land at the origin card (or the top), so travel never
   * inherits the previous document's scroll offset. Runs from updated() so a
   * lane that loads after the follow still lands. */
  private _scrolledForArrival: string | null = null
  private _scrollToArrival(): void {
    if (!this._arrivalKey || this._scrolledForArrival === this._arrivalKey) return
    const laneEl = this.renderRoot.querySelector('.lane[data-current=\'true\']') as HTMLElement | null
    if (!laneEl) return
    const target = this.renderRoot.querySelector('.row.origin .primary-card, .row.origin .doc-card') as HTMLElement | null
    if (!target) return // lane still loading; a later updated() catches it
    this._scrolledForArrival = this._arrivalKey
    const lr = laneEl.getBoundingClientRect()
    const tr = target.getBoundingClientRect()
    laneEl.scrollTop = Math.max(0, tr.top - lr.top + laneEl.scrollTop - lr.height * 0.3)
  }

  /** point-in-triangle, barycentric sign test. */
  private _coneCleanup: (() => void) | null = null
  /** While a cone is armed, its containment test lives here — cards crossed
   * in transit to the fan must not steal the hover the cone is carrying. */
  private _coneIn: ((x: number, y: number) => boolean) | null = null
  private _coneKind: 'stack' | 'fan' = 'stack'
  /** The row that owns the current sustained hover (set ONLY by resting on the
   * owner card — entering a wire card directly from outside unfurls nothing). */
  @state() private _focalRowKey: string | null = null
  /** Which side the cone exited toward; null while resting on the owner card
   * (both stacks unfurl). Outbound-right unfurls only the right. */
  @state() private _coneSide: 'left' | 'right' | null = null

  /**
   * The hover cone (her 2026-10-14 ask, hardened after her play): leaving the
   * owner card — or a wire card heading out to its fan — does not end the
   * hover while the pointer travels inside the triangle toward the target
   * zone, and there is NO dwell timeout while the pointer is inside the cone
   * or over the row/fan (her catch: slowing down between secondaries must not
   * collapse anything). The hover ends on leaving the cone toward elsewhere,
   * or entering another row.
   */
  private _coneFrom(
    event: PointerEvent,
    fromCard: HTMLElement,
    targetSel: string,
    clearKey: string,
    side: 'left' | 'right',
    kind: 'stack' | 'fan',
  ): void {
    const row = fromCard.closest('.row') as HTMLElement | null
    const target = (fromCard.closest('.lane') ?? this.renderRoot).querySelector<HTMLElement>(targetSel)
    if (!row || !target) { if (this._hoveredId === clearKey) this._hoveredId = null; return }
    const targetRect = target.getBoundingClientRect()
    const apex = { x: event.clientX, y: event.clientY }
    const baseX = side === 'right' ? targetRect.left : targetRect.right
    const top = { x: baseX, y: targetRect.top - 24 }
    const bottom = { x: baseX, y: targetRect.bottom + 24 }
    this._coneCleanup?.()
    let last = apex
    const overSafeZone = (p: typeof apex): boolean => {
      const under = (this.renderRoot as ShadowRoot & { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint?.(p.x, p.y) ?? null
      if (!under) return false
      return under.closest('.row') === row || Boolean(under.closest('.tertiary'))
    }
    const inCone = (p: typeof apex): boolean => {
      const cross = (a: typeof p, b: typeof p, c: typeof p) => (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
      const d1 = cross(p, apex, top)
      const d2 = cross(p, top, bottom)
      const d3 = cross(p, bottom, apex)
      return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)))
    }
    const onMove = (e: PointerEvent): void => {
      last = { x: e.clientX, y: e.clientY }
      if (inCone(last)) return
      if (overSafeZone(last)) return
      cleanup()
      if (this._hoveredId === clearKey) this._hoveredId = null
      if (this._focalRowKey === clearKey) { this._focalRowKey = null; this._coneSide = null }
    }
    const cleanup = (): void => {
      this.renderRoot.removeEventListener('pointermove', onMove as EventListener)
      window.clearTimeout(timer)
      if (this._coneCleanup === cleanup) this._coneCleanup = null
      this._coneIn = null
    }
    // No hard clear while the pointer lingers INSIDE the cone or over the
    // row/fan — the timer re-arms instead of ending a legitimate dwell.
    let timer = 0
    const arm = (): void => {
      timer = window.setTimeout(() => {
        if (inCone(last) || overSafeZone(last)) { arm(); return }
        cleanup()
        if (this._hoveredId === clearKey) this._hoveredId = null
        if (this._focalRowKey === clearKey) { this._focalRowKey = null; this._coneSide = null }
      }, 1200)
      this._timers.push(timer)
    }
    arm()
    this._coneCleanup = cleanup
    this._coneIn = (x, y) => inCone({ x, y })
    this._coneKind = kind
    this.renderRoot.addEventListener('pointermove', onMove as EventListener)
  }

  /** Leaving a primary or the doc card: cone toward the wire stack on the
   * exit side (and remember the side, so only that stack unfurls). */
  private _leaveOwnerWithCone(event: PointerEvent, rowKey: string): void {
    const card = event.currentTarget as HTMLElement
    const cardRect = card.getBoundingClientRect()
    const x = event.clientX
    let side: 'left' | 'right' | null = null
    if (x <= cardRect.left) side = 'left'
    else if (x >= cardRect.right) side = 'right'
    if (!side) {
      // left vertically: no cone, but resting ON the card keeps focal; leaving
      // up/down ends it.
      if (this._hoveredId === rowKey) this._hoveredId = null
      if (this._focalRowKey === rowKey) { this._focalRowKey = null }
      return
    }
    this._coneSide = side
    this._coneFrom(event, card, side === 'left' ? '.stack:first-of-type' : '.stack:last-of-type', rowKey, side, 'stack')
  }

  /** "N wired above / below" — the scroll hints (her last 1.0 ask,
   * 2026-10-16): viewport-fixed, clickable jumps to the nearest wired block
   * offscreen in that direction. Recomputed on scroll with the links. */
  private _updateScrollHints(step: TrailStep): void {
    const lane = this._lane(step.docId)
    const laneEl = this.renderRoot.querySelector('.lane[data-current=\'true\']') as HTMLElement | null
    if (!lane || !laneEl) return
    const up = this.renderRoot.querySelector('.scroll-hint.up') as HTMLElement | null
    const down = this.renderRoot.querySelector('.scroll-hint.down') as HTMLElement | null
    if (!up || !down) return
    const laneRect = laneEl.getBoundingClientRect()
    const scrollTop = laneEl.scrollTop
    const viewport = laneEl.clientHeight
    const positions: Array<{ id: string; top: number; bottom: number }> = []
    // The doc card counts too (her 2026-10-16): a document with doc-level
    // wires is itself a wired address, so it joins the counts and the jumps.
    if (lane.docWires.length > 0) {
      const docCard = this.renderRoot.querySelector('.row.docrow .doc-card')
      if (docCard) {
        const r = docCard.getBoundingClientRect()
        if (r.width > 0) {
          positions.push({ id: 'doc', top: r.top - laneRect.top + scrollTop, bottom: r.bottom - laneRect.top + scrollTop })
        }
      }
    }
    for (const blockId of lane.blockWires.keys()) {
      const el = this.renderRoot.querySelector(`[data-rowkey="${step.id}:${blockId}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      positions.push({
        id: blockId,
        top: r.top - laneRect.top + scrollTop,
        bottom: r.bottom - laneRect.top + scrollTop,
      })
    }
    const below = positions.filter(p => p.top > scrollTop + viewport - 40)
    const above = positions.filter(p => p.bottom < scrollTop + 40)
    down.textContent = below.length > 0 ? `${below.length} wired below ↓` : ''
    up.textContent = above.length > 0 ? `${above.length} wired above ↑` : ''
    down.style.display = below.length > 0 ? '' : 'none'
    up.style.display = above.length > 0 ? '' : 'none'
  }

  private _jumpWired(step: TrailStep, direction: 'up' | 'down'): void {
    const lane = this._lane(step.docId)
    const laneEl = this.renderRoot.querySelector('.lane[data-current=\'true\']') as HTMLElement | null
    if (!lane || !laneEl) return
    const laneRect = laneEl.getBoundingClientRect()
    const scrollTop = laneEl.scrollTop
    const viewport = laneEl.clientHeight
    const positions: Array<{ top: number; bottom: number }> = []
    if (lane.docWires.length > 0) {
      const docCard = this.renderRoot.querySelector('.row.docrow .doc-card')
      if (docCard) {
        const r = docCard.getBoundingClientRect()
        if (r.width > 0) {
          positions.push({ top: r.top - laneRect.top + scrollTop, bottom: r.bottom - laneRect.top + scrollTop })
        }
      }
    }
    for (const blockId of lane.blockWires.keys()) {
      const el = this.renderRoot.querySelector(`[data-rowkey="${step.id}:${blockId}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      positions.push({
        top: r.top - laneRect.top + scrollTop,
        bottom: r.bottom - laneRect.top + scrollTop,
      })
    }
    if (direction === 'down') {
      const next = positions.filter(p => p.top > scrollTop + viewport - 40).sort((a, b) => a.top - b.top)[0]
      if (next) laneEl.scrollTop = Math.max(0, next.top - 80)
    } else {
      const prev = positions.filter(p => p.bottom < scrollTop + 40).sort((a, b) => b.top - a.top)[0]
      if (prev) laneEl.scrollTop = Math.max(0, prev.top - 60)
    }
  }

  /** The tertiary fan hangs at the hovered wire card's height. */
  private _positionTertiary(): void {
    const el = this.renderRoot.querySelector<HTMLElement>('.tertiary')
    if (!el || !this._hoveredId) return
    const card = this.renderRoot.querySelector(`[data-wire="${CSS.escape(this._hoveredId)}"]`)
    const lane = el.closest('.lane') as HTMLElement | null
    if (!card || !lane) return
    const cardRect = card.getBoundingClientRect()
    if (cardRect.width === 0 && cardRect.height === 0) return // hidden (collapsed group member)
    const laneRect = lane.getBoundingClientRect()
    el.style.top = `${Math.max(0, cardRect.top - laneRect.top + lane.scrollTop)}px`
    // Anchor to the stack's OUTER edge, not the lane's — the fan should hang
    // just past the stack it fanned from, at any window width.
    const stack = card.closest('.stack') as HTMLElement | null
    if (stack) {
      const stackRect = stack.getBoundingClientRect()
      if (el.classList.contains('left')) {
        el.style.left = `${Math.max(4, stackRect.left - laneRect.left + lane.scrollLeft - 180 - 10)}px`
        el.style.right = ''
      } else {
        el.style.left = `${stackRect.right - laneRect.left + lane.scrollLeft + 10}px`
        el.style.right = ''
      }
    }
  }

  // ── Public entry points (called by the shell layer) ───────────────────────

  openTraverse(docId: string, arrival?: MspArrival): void {
    const step: TrailStep = {
      id: 0,
      docId,
      arrivedBy: arrival?.direction ?? null,
      departedDir: null,
      viaPredicate: arrival?.viaPredicate ?? null,
      arriveAtBlockId: arrival?.arriveAtBlockId ?? null,
      fromDocTitle: arrival?.fromDocTitle ?? null,
    }
    this._walk = [step]
    this._hoveredId = null
    this._focalRowKey = null
    this._coneSide = null
    this._coneCleanup?.()
    this._hoveredMiniId = null
    this._scrolledForArrival = null // every handoff scrolls, even a repeat to the same doc+block
    this._arrivalKey = arrival ? `${docId}:${arrival.arriveAtBlockId ?? 'doc'}:${step.id}` : null
    this._showPrev = false
    this._panPhase = 'idle'
    this._view = 'traverse'
    // Fresh entry: cancel any pending close, drop every cached lane (stale
    // text/wires/renames must not survive a reopen), refresh titles, and
    // give the stage focus so typing lands here, not in the editor.
    this._leaving = false
    this._lanes = new Map()
    this.adapter.listDocs()
    this.style.display = ''
    const laneEl = this.renderRoot.querySelector('.lane[data-current=\'true\']') as HTMLElement | null
    if (laneEl) laneEl.scrollTop = 0
    void this._ensureLane(docId)
    if (this._arrivalKey) this._later(() => { this._arrivalKey = null }, 1000)
  }

  openCreate(docId: string, blockId: string | null): void {
    this._originDocId = docId
    this._originBlockId = blockId
    this._target = null
    this._direction = 'out'
    this._phase = 'find'
    this._ring = null
    this._findDocId = null
    this._forming = null
    this._settling = false
    this._query = ''
    this._searchHits = []
    this._candidates = []
    this._view = 'create'
    void this._ensureLane(docId).then(() => {
      // Semantic candidates: the unconscious offers targets, never predicates.
      const originText = this._blocks.get(docId)?.find(b => b.id === blockId)?.text
        ?? this._lanes.get(docId)
      const text = typeof originText === 'string' ? originText : ''
      void this.adapter.loadCandidates(docId, text).then(c => {
        if (this._view === 'create') this._candidates = c
      }).catch(() => undefined)
    })
  }

  private async _ensureLane(docId: string): Promise<void> {
    if (this._lanes.has(docId)) return
    const token = ++this._loadToken
    this._lanes = new Map(this._lanes).set(docId, 'loading')
    try {
      const lane = await this.adapter.loadLane(docId)
      if (token < this._loadToken - 4) {
        { const next = new Map(this._lanes); next.delete(docId); this._lanes = next } // never a permanent 'loading'
        return
      }
      this._lanes = new Map(this._lanes).set(docId, lane)
      this._blocks = new Map(this._blocks).set(docId, lane.blocks)
      // Prefetch the blocks of every doc this lane's wires point at, so
      // secondary hover (full block text) is instant — the old build's rule.
      const others = new Set<string>()
      for (const w of lane.docWires) others.add(w.otherDocId)
      for (const wires of lane.blockWires.values()) for (const w of wires) others.add(w.otherDocId)
      // Cap the eager fan-out (Delta's review: ~39 at once for the Antinomies);
      // the rest lazy-load on first hover.
      for (const otherId of [...others].slice(0, 12)) {
        if (this._blocks.has(otherId)) continue
        void this.adapter.loadBlocks(otherId).then(blocks => {
          this._blocks = new Map(this._blocks).set(otherId, blocks)
        }).catch(() => undefined)
      }
    } catch (err) {
      console.error('[msp] lane load failed for', docId, err)
      { const next = new Map(this._lanes); next.delete(docId); this._lanes = next } // 'error' is not cached forever; a reopen retries
    }
  }

  private _lane(docId: string): MspLaneData | null {
    const v = this._lanes.get(docId)
    return v && v !== 'loading' && v !== 'error' ? v : null
  }

  // ── Connector lines (her 2026-10-14: hover a block or the doc card and
  // lines lean out to all its wire cards; hover a wire card and only its own
  // line shows — "which wires belong to which blocks" made visible) ─────────

  private _linksRaf = 0
  private _hoveredMiniId: string | null = null
  /** In-flight loadBlocks doc ids, so hover-driven re-renders can't stack
   * duplicate requests (Delta's small note, second re-review). */
  private _blocksLoading = new Set<string>()

  private _scheduleLinks(): void {
    if (this._linksRaf) return
    this._linksRaf = requestAnimationFrame(() => {
      this._linksRaf = 0
      this._updateLinks()
      this._syncGroupKeep()
      if (this._current) this._updateScrollHints(this._current)
    })
  }

  /** Group keepalive (her 2026-10-16 catch): hovering a member OR its fan
   * keeps the group unfurled — otherwise rolling onto a mini rolled the
   * group back up and every mini's line flashed from the corner. */
  private _syncGroupKeep(): void {
    for (const el of this.renderRoot.querySelectorAll('.docgroup.keep')) el.classList.remove('keep')
    const keepIds = new Set<string>()
    if (this._hoveredId) keepIds.add(this._hoveredId)
    if (this._hoveredMiniId) {
      const mini = this.renderRoot.querySelector(`[data-mini="${CSS.escape(this._hoveredMiniId)}"]`)
      const parentId = mini?.getAttribute('data-parent')
      if (parentId) keepIds.add(parentId)
    }
    for (const id of keepIds) {
      const card = this.renderRoot.querySelector(`[data-wire="${CSS.escape(id)}"]`)
      card?.closest('.docgroup')?.classList.add('keep')
    }
  }

  private _updateLinks(): void {
    const svg = this.renderRoot.querySelector<SVGSVGElement>('.lane .links')
    if (!svg) return
    const lane = svg.closest('.lane') as HTMLElement | null
    if (!lane) return
    const laneRect = lane.getBoundingClientRect()
    const toContent = (r: DOMRect) => ({
      left: r.left - laneRect.left + lane.scrollLeft,
      right: r.right - laneRect.left + lane.scrollLeft,
      midY: r.top - laneRect.top + lane.scrollTop + r.height / 2,
    })
    // No viewBox/height sizing: the svg is viewport-sized with
    // overflow:visible, so it can't inflate the lane's scrollHeight (an
    // absolutely-positioned child counts toward scrollable overflow — sizing
    // it to scrollHeight pinned a shorter doc to the previous one's length).

    const hovered = this._hoveredId
    const paths: string[] = []
    if (hovered) {
      const esc = CSS.escape(hovered)
      const ownerCard = this.renderRoot.querySelector(`[data-rowkey="${esc}"]`)
      const pairs: Array<[Element, Element]> = []
      if (ownerCard) {
        for (const target of this.renderRoot.querySelectorAll(`[data-owner="${esc}"]`)) {
          pairs.push([ownerCard, target])
        }
      } else {
        const wireCard = this.renderRoot.querySelector(`[data-wire="${esc}"]`)
        const owner = wireCard?.getAttribute('data-owner')
        const ownerEl = owner ? this.renderRoot.querySelector(`[data-rowkey="${CSS.escape(owner)}"]`) : null
        if (wireCard && ownerEl) pairs.push([wireCard, ownerEl])
        // …and a line out to every mini in its fan, as a primary draws to
        // every secondary (her 2026-10-14 symmetry ask).
        if (wireCard) {
          for (const mini of this.renderRoot.querySelectorAll(`[data-parent="${esc}"]`)) {
            pairs.push([wireCard, mini as Element])
          }
        }
      }
      // A hovered mini card draws its own line back to the wire it fanned from.
      if (this._hoveredMiniId) {
        const mini = this.renderRoot.querySelector(`[data-mini="${CSS.escape(this._hoveredMiniId)}"]`)
        const parentId = mini?.getAttribute('data-parent')
        const parent = parentId ? this.renderRoot.querySelector(`[data-wire="${CSS.escape(parentId)}"]`) : null
        if (mini && parent) pairs.push([mini as Element, parent as Element])
      }
      for (const [from, to] of pairs) {
        const fromRect = from.getBoundingClientRect()
        if (fromRect.width === 0 && fromRect.height === 0) continue
        const toRect = to.getBoundingClientRect()
        if (toRect.width === 0 && toRect.height === 0) continue // display:none (collapsed group member) — its rect is the corner
        const a = toContent(from.getBoundingClientRect())
        const b = toContent(toRect)
        const leftward = (b.left + b.right) / 2 < (a.left + a.right) / 2
        const x1 = leftward ? a.left : a.right
        const x2 = leftward ? b.right : b.left
        const mx = (x1 + x2) / 2
        paths.push(`M ${x1},${a.midY} C ${mx},${a.midY} ${mx},${b.midY} ${x2},${b.midY}`)
      }
    }
    svg.innerHTML = paths.map(d => `<path d="${d}" />`).join('')
  }

  // ── Traversal ─────────────────────────────────────────────────────────────

  private _follow(wire: MspWire) {
    const dir = wire.direction
    const cur = this._current!
    const updated: TrailStep = { ...cur, departedDir: dir }
    const step: TrailStep = {
      id: this._nextStepId++,
      docId: wire.otherDocId,
      arrivedBy: dir,
      departedDir: null,
      viaPredicate: wire.predicateLabel,
      arriveAtBlockId: wire.otherBlockId,
    }
    this._walk = [...this._walk.slice(0, -1), updated, step]
    this._panDir = dir
    this._showPrev = true
    this._panPhase = 'start'
    this._hoveredId = null
    this._focalRowKey = null
    this._coneSide = null
    this._coneCleanup?.()
    this._hoveredMiniId = null
    this._arrivalKey = `${wire.otherDocId}:${wire.otherBlockId ?? 'doc'}:${step.id}`
    this.updateComplete.then(() => {
      requestAnimationFrame(() => { this._panPhase = 'settle' })
    })
    this._later(() => { this._showPrev = false; this._panPhase = 'idle' }, PAN_MS + 120)
    this._later(() => { this._arrivalKey = null }, 1000)
    void this._ensureLane(wire.otherDocId)
  }

  private _rewind(toId: number) {
    const idx = this._walk.findIndex(s => s.id === toId)
    if (idx < 0 || idx === this._walk.length - 1) return
    const target = this._walk[idx]
    const rewindDir: 'out' | 'in' = target.departedDir === 'out' ? 'in' : 'out'
    this._walk = this._walk.slice(0, idx + 1)
    this._panDir = rewindDir
    this._showPrev = true
    this._panPhase = 'start'
    this._hoveredId = null
    this.updateComplete.then(() => {
      requestAnimationFrame(() => { this._panPhase = 'settle' })
    })
    this._later(() => { this._showPrev = false; this._panPhase = 'idle' }, PAN_MS + 120)
  }

  private get _current(): TrailStep | null { return this._walk.length ? this._walk[this._walk.length - 1] : null }
  private get _prev(): TrailStep | null { return this._walk.length > 1 ? this._walk[this._walk.length - 2] : null }

  private _exitToBlock(docId: string, blockId: string | null) {
    const detail = { docId, blockId }
    this._goHome()
    this.dispatchEvent(new CustomEvent('msp-open-document', { detail, bubbles: true, composed: true }))
  }

  /** Close the veil from outside (native menu accelerators, the shell's
   * dialogs). Idempotent. */
  close(): void {
    if (this._view === 'closed') return
    this._goHome()
  }

  private _goHome() {
    if (this._leaving) return // a second Esc in the close window is not a second close
    this._leaving = true
    this._later(() => {
      this._view = 'closed'
      this._leaving = false
      this._forming = null
      this._settling = false
      this._target = null
      this._phase = 'find'
      this._ring = null
      this._findDocId = null
      this.removeAttribute('data-open')
      this.dispatchEvent(new CustomEvent('msp-close', { bubbles: true, composed: true }))
    }, 280)
  }

  // ── Creation ──────────────────────────────────────────────────────────────

  private _pickTarget(docId: string, blockId: string | null) {
    this._target = { docId, blockId }
    this._phase = 'craft'
    void this._ensureLane(docId)
    // The crafting moment: let the pair settle into center, then bloom the
    // ring at the midpoint between the two facing edges.
    this.updateComplete.then(() => {
      this._later(() => {
        const originEl = this.renderRoot.querySelector('.origin-anchor')
        const targetEl = this.renderRoot.querySelector('.target-anchor')
        const veilEl = this.renderRoot.querySelector('.veil')
        if (!originEl || !targetEl || !veilEl || this._view !== 'create') return
        const vr = veilEl.getBoundingClientRect()
        const or = originEl.getBoundingClientRect()
        const tr = targetEl.getBoundingClientRect()
        const mx = ((or.right + tr.left) / 2) - vr.left
        const my = ((or.top + or.height / 2) + (tr.top + tr.height / 2)) / 2 - vr.top
        this._ring = { x: vr.left + mx, y: vr.top + my, sel: -1 }
      }, 240)
    })
  }

  private _backToFind() {
    this._phase = 'find'
    this._ring = null
  }

  private _ringScroll(e: WheelEvent) {
    if (!this._ring) return
    e.preventDefault()
    const preds = this.adapter ? MSP_RING_PREDICATES : MSP_RING_PREDICATES
    const n = preds.length
    const delta = e.deltaY > 0 ? 1 : -1
    const cur = this._ring.sel < 0 ? (delta > 0 ? 0 : n - 1) : (this._ring.sel + delta + n) % n
    this._ring = { ...this._ring, sel: cur }
  }

  private async _commitWire(predicate: string) {
    if (!this._target || this._writing) return
    this._ring = null
    const originEl = this.renderRoot.querySelector('.origin-anchor')
    const targetEl = this.renderRoot.querySelector('.target-anchor')
    const veilEl = this.renderRoot.querySelector('.veil')
    if (originEl && targetEl && veilEl) {
      const vr = veilEl.getBoundingClientRect()
      const or = originEl.getBoundingClientRect()
      const tr = targetEl.getBoundingClientRect()
      const src = this._direction === 'out' ? or : tr
      const dst = this._direction === 'out' ? tr : or
      const leftward = (dst.left + dst.width / 2) < (src.left + src.width / 2)
      const x1 = (leftward ? src.left : src.right) - vr.left
      const y1 = src.top + src.height / 2 - vr.top
      const x2 = (leftward ? dst.right : dst.left) - vr.left
      const y2 = dst.top + dst.height / 2 - vr.top
      const mx = (x1 + x2) / 2
      const d = `M ${x1},${y1} C ${mx},${y1} ${mx},${y2} ${x2},${y2}`
      const len = Math.hypot(x2 - x1, y2 - y1) * 1.4
      const label = this._direction === 'out' ? `${predicate} →` : `← ${predicate}`
      this._forming = { d, lx: mx, ly: (y1 + y2) / 2, label, len }
    }

    // The REAL write. The arc plays while the cell enqueues the CRDT op.
    const commit: MspWireCommit = this._direction === 'out'
      ? {
          sourceDocId: this._originDocId,
          sourceBlockId: this._originBlockId,
          targetDocId: this._target.docId,
          targetBlockId: this._target.blockId,
          predicate,
        }
      : {
          sourceDocId: this._target.docId,
          sourceBlockId: this._target.blockId,
          targetDocId: this._originDocId,
          targetBlockId: this._originBlockId,
          predicate,
        }
    this._writing = true
    let failed = false
    try {
      await this.adapter.createWire(commit)
    } catch {
      failed = true
    }
    this._writing = false
    if (failed) {
      this._forming = null
      this.dispatchEvent(new CustomEvent('msp-write-failed', { bubbles: true, composed: true }))
      return
    }
    this.dispatchEvent(new CustomEvent('msp-created', { detail: commit, bubbles: true, composed: true }))
    this._later(() => { this._settling = true }, TIMINGS.settle)
    this._later(() => this._goHome(), TIMINGS.home)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render() {
    if (this._view === 'closed') return nothing
    return this._view === 'traverse' ? this._renderTraverse() : this._renderCreate()
  }

  private _renderTraverse() {
    const current = this._current!
    const lane = this._lane(current.docId)
    const title = lane?.title ?? this.adapter.docTitle(current.docId)
    return html`
      <div class="veil ${this._leaving ? 'leaving' : ''}">
        <div class="stage-head">
          <div><span class="mode-pill">Spread</span><span class="docname">${title}</span></div>
          <div class="keys">click a side card to follow its wire · the glowing card is where you came from — click it to go back · click a center card to read in the editor · Esc closes</div>
          <button class="bar" @click=${() => this._goHome()}>Close</button>
        </div>
        <div class="viewport">
          ${this._showPrev && this._prev ? this._renderLane(this._prev, false, this._panPhase === 'start' ? '' : (this._panDir === 'out' ? 'behind-left' : 'behind-right')) : nothing}
          ${this._renderLane(current, true, this._panPhase === 'start' ? (this._panDir === 'out' ? 'behind-right' : 'behind-left') : '')}
          ${html`<div class="scroll-hint up" @click=${() => this._jumpWired(current, 'up')}></div>`}
          ${html`<div class="scroll-hint down" @click=${() => this._jumpWired(current, 'down')}></div>`}
        </div>
      </div>
    `
  }

  private _renderLane(step: TrailStep, isCurrent: boolean, behindCls: string) {
    const lane = this._lane(step.docId)
    if (!lane) {
      const failed = this._lanes.get(step.docId) === 'error'
      return html`
        <div class="lane ${behindCls}">
          <div class="lane-loading">${failed ? `Couldn't load ${this.adapter.docTitle(step.docId)} (see console) — Esc to close` : `Loading ${this.adapter.docTitle(step.docId)}…`}</div>
        </div>
      `
    }
    // The total reading surface (Eschaton, 2026-10-09): EVERY block renders in
    // document order, wiredness as the compression axis — wired blocks get the
    // full card row with their wire stacks, unwired blocks render compact and
    // expand on hover. The arrival block always renders full: it is where you ARE.
    const rows = lane.blocks.map(b => b.id)
    const indexById = new Map(lane.blocks.map((b, i) => [b.id, i] as const))
    return html`
      <div
        class="lane ${behindCls} ${isCurrent ? 'fading-in' : ''}"
        tabindex="-1"
        data-current=${isCurrent ? 'true' : 'false'}
        data-hovering=${this._hoveredId && isCurrent ? 'true' : 'false'}
        @scroll=${() => this._scheduleLinks()}
      >
        ${isCurrent ? html`<svg class="links"></svg>` : nothing}
        ${isCurrent ? this._renderTertiary(lane) : nothing}
        <div class="rows">
          ${this._renderDocCard(lane, step, isCurrent)}
          ${rows.map(blockId => this._renderRow(step, lane, blockId, isCurrent, indexById))}
        </div>
      </div>
    `
  }

  /**
   * Doc-level wires, grouped by predicate (her collapse grammar, 2026-10-09):
   * one chip per group at rest ("exemplifies ×7"), the group unfurls its
   * members on hover. A doc with 23 doc-level wires was 1398px tall — taller
   * than the viewport, burying every block. Single-wire groups render the
   * wire directly, no wrapper.
   */
  private _renderDocWireStack(
    wires: readonly MspWire[],
    isCurrent: boolean,
    owner: { rowKey: string; docId: string; blockId: string | null },
  ) {
    const groups = new Map<string, MspWire[]>()
    for (const w of wires) {
      const list = groups.get(w.predicateLabel) ?? []
      list.push(w)
      groups.set(w.predicateLabel, list)
    }
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length || a[0]!.predicateLabel.localeCompare(b[0]!.predicateLabel))
    return sorted.map(group => {
      if (group.length === 1) return this._renderSecondary(group[0]!, isCurrent, owner)
      return html`
        <div class="docgroup">
          <div class="card docwire group-chip">
            <div class="doc-tag">${group[0]!.predicateLabel} × ${group.length}</div>
            <span class="pred">hover to unfurl</span>
          </div>
          <div class="members">
            ${group.map(w => this._renderSecondary(w, isCurrent, owner))}
          </div>
        </div>
      `
    })
  }

  private _renderDocCard(lane: MspLaneData, step: TrailStep, isCurrent: boolean) {
    const isOrigin = isCurrent && step.arriveAtBlockId === null && (step.arrivedBy !== null || step.viaPredicate !== null || !!step.fromDocTitle)
    const docFocal = this._focalRowKey === `doc:${lane.docId}` && isCurrent
    return html`
      <div class="row docrow ${docFocal ? 'focal' : ''} ${isOrigin ? 'origin' : ''}">
        <div class="stack ${docFocal && (!this._coneSide || this._coneSide === 'left') ? 'unfurl' : ''}">
          ${this._renderDocWireStack(lane.docWires.filter(w => w.direction === 'in'), isCurrent, { rowKey: `doc:${lane.docId}`, docId: lane.docId, blockId: null })}
        </div>
        <div
          class="card doc-card primary-card ${this._arrivalKey === `${lane.docId}:doc:${step.id}` ? 'arrival' : ''}"
          data-rowkey="doc:${lane.docId}"
          title=${isOrigin ? `came here via ${step.viaPredicate ?? 'a wire'}${this._prev ? ' — click to go back' : ''}` : nothing}
          @click=${() => { if (isOrigin && this._prev) this._rewind(this._prev.id) }}
          @pointerenter=${(e: PointerEvent) => {
            if (!isCurrent) return
            const dk = `doc:${lane.docId}`
            if (this._coneKind === 'fan' && this._coneIn && this._hoveredId && this._hoveredId !== dk && this._coneIn(e.clientX, e.clientY)) return
            this._coneCleanup?.()
            this._hoveredId = dk
            this._focalRowKey = dk
            this._coneSide = null
          }}
          @pointerleave=${(e: PointerEvent) => { if (isCurrent) this._leaveOwnerWithCone(e, `doc:${lane.docId}`) }}
        >
          <div class="doc-tag">Document</div>
          ${lane.title}
          ${isOrigin && (this._prev || step.fromDocTitle) ? html`<div class="doc-tag" style="margin-top:4px;opacity:0.85">↑ came from ${this._prev ? this.adapter.docTitle(this._prev.docId) : step.fromDocTitle} · ${step.viaPredicate}</div>` : nothing}
        </div>
        <div class="stack ${docFocal && (!this._coneSide || this._coneSide === 'right') ? 'unfurl' : ''}">
          ${this._renderDocWireStack(lane.docWires.filter(w => w.direction === 'out'), isCurrent, { rowKey: `doc:${lane.docId}`, docId: lane.docId, blockId: null })}
        </div>
      </div>
    `
  }

  private _renderRow(step: TrailStep, lane: MspLaneData, blockId: string, isCurrent: boolean, indexById: ReadonlyMap<string, number>) {
    const idx = indexById.get(blockId) ?? -1
    const block = lane.blocks[idx]
    const wires = lane.blockWires.get(blockId) ?? []
    const isOrigin = isCurrent && step.arriveAtBlockId === blockId && (step.arrivedBy !== null || step.viaPredicate !== null || !!step.fromDocTitle)
    const key = `${step.id}:${blockId}`
    // Focal is OWNED: set by resting on the primary card, sustained through
    // the cone and over this row's wire cards, never created by entering a
    // wire card from outside (her 2026-10-14 ruling: direct-to-secondary
    // unfurls nothing).
    const focal = this._focalRowKey === key && isCurrent
    const arrival = this._arrivalKey === `${lane.docId}:${blockId}:${step.id}`
    if (!block) return nothing

    // Unwired and not the arrival: the compressed reading surface. Small,
    // quiet, tight; hover expands in place (the top edge never moves — the
    // reflow goes downward, so the pointer's target is stable). Click reads
    // the block in the editor, same as a primary. Hover is PURE CSS here —
    // routing it through Lit state swaps the node under the pointer and the
    // expansion flickers away.
    if (wires.length === 0 && !isOrigin && !arrival) {
      const heading = block.type === 'Heading' ? ` h${Math.min(block.level ?? 3, 3)}` : ''
      return html`
        <div
          class="row compact${heading}"
          title="Read in the editor"
          @click=${(e: MouseEvent) => {
            e.stopPropagation()
            if (isCurrent) this._exitToBlock(lane.docId, blockId)
          }}
        >
          <div class="compact-text">${block.text}</div>
        </div>
      `
    }

    const originBack = () => { if (isOrigin && this._prev) this._rewind(this._prev.id) }
    return html`
      <div class="row ${focal ? 'focal' : ''} ${isOrigin ? 'origin' : ''}">
        <div class="stack ${focal && (!this._coneSide || this._coneSide === 'left') ? 'unfurl' : ''}">
          ${this._renderDocWireStack(wires.filter(w => w.direction === 'in'), isCurrent, { rowKey: key, docId: lane.docId, blockId })}
        </div>
        <div
          class="card primary-card ${arrival ? 'arrival' : ''}"
          data-rowkey=${key}
          title=${isOrigin ? `came here via ${step.viaPredicate ?? 'a wire'}${this._prev ? ' — click to go back' : ''}` : 'Read in the editor'}
          @click=${(e: MouseEvent) => {
            e.stopPropagation()
            if (isOrigin) originBack()
            else this._exitToBlock(lane.docId, blockId)
          }}
          @pointerenter=${(e: PointerEvent) => {
            if (!isCurrent) return
            if (this._coneKind === 'fan' && this._coneIn && this._hoveredId && this._hoveredId !== key && this._coneIn(e.clientX, e.clientY)) return
            this._coneCleanup?.()
            this._hoveredId = key
            this._focalRowKey = key
            this._coneSide = null
          }}
          @pointerleave=${(e: PointerEvent) => { if (isCurrent) this._leaveOwnerWithCone(e, key) }}
        >
          ${isOrigin && (this._prev || step.fromDocTitle) ? html`<div class="doc-tag" style="margin-bottom:4px">↑ came from ${this._prev ? this.adapter.docTitle(this._prev.docId) : step.fromDocTitle} · ${step.viaPredicate}</div>` : nothing}
          <div class="body">${block.text}</div>
        </div>
        <div class="stack ${focal && (!this._coneSide || this._coneSide === 'right') ? 'unfurl' : ''}">
          ${this._renderDocWireStack(wires.filter(w => w.direction === 'out'), isCurrent, { rowKey: key, docId: lane.docId, blockId })}
        </div>
      </div>
    `
  }

  /** The card a wire hangs off: its row key (for connector lines) and its own
   * endpoint (so a second-order fan can drop the wire that points back). */
  private _renderSecondary(
    w: MspWire,
    isCurrent: boolean,
    owner: { rowKey: string; docId: string; blockId: string | null },
  ) {
    const hovered = this._hoveredId === w.id
    const otherBlocks = this._blocks.get(w.otherDocId)
    if (hovered && w.otherBlockId && !otherBlocks && !this._blocksLoading.has(w.otherDocId)) {
      this._blocksLoading.add(w.otherDocId)
      void this.adapter.loadBlocks(w.otherDocId).then(blocks => {
        this._blocks = new Map(this._blocks).set(w.otherDocId, blocks)
      }).catch(() => undefined).finally(() => {
        this._blocksLoading.delete(w.otherDocId)
      })
    }
    const fullBlock = w.otherBlockId ? otherBlocks?.find(b => b.id === w.otherBlockId) : undefined
    // Document-level wires carry no preview at rest (title + predicate only,
    // her 2026-10-09 space ruling); hover still expands to it. Block-level
    // wires keep the snippet at rest, full text on hover. "no preview" is
    // never printed — absence says it (2026-10-14).
    const docLevel = !w.otherBlockId
    const preview = docLevel && !hovered
      ? nothing
      : hovered && fullBlock
        ? html`<div class="full">${fullBlock.text}</div>`
        : (w.otherSnippet || nothing)
    return html`
      <div
        class="card ${docLevel ? 'docwire' : ''} ${hovered ? 'hovered' : ''}"
        data-wire=${w.id}
        data-owner=${owner.rowKey}
        @pointerenter=${(e: PointerEvent) => {
          if (!isCurrent) return
          // A cone is carrying a hover somewhere and this card is on the path
          // through the stack — transit steals nothing.
          if (this._coneKind === 'fan' && this._coneIn && this._hoveredId && this._hoveredId !== w.id && this._coneIn(e.clientX, e.clientY)) return
          this._hoveredId = w.id
          // Second-order fan (her 2026-10-14 call: try the real wires before
          // the summary fallback) — lazy-load the target's lane once.
          void this._ensureLane(w.otherDocId)
        }}
        @pointerleave=${(e: PointerEvent) => {
          if (!isCurrent) return
          if ((e.relatedTarget as Element | null)?.closest?.('.tertiary')) return
          // Any exit while this card's fan is up cones toward the fan — the
          // fan overlaps the card's own column and hangs BELOW it too, so
          // leaving downward is as natural as leaving sideways (her "+N more
          // doesn't extend the cone," 2026-10-14).
          const outward = w.direction === 'in' ? 'left' : 'right'
          if (this._lane(w.otherDocId)) {
            // The fan cone clears the OWNING row's focal, not just this
            // card's hover — A's focal never gets stranded by B's cone.
            this._coneFrom(e, e.currentTarget as HTMLElement, `.tertiary.${outward}`, this._focalRowKey ?? w.id, outward, 'fan')
            return
          }
          if (this._hoveredId === w.id) {
            this._hoveredId = null
            this._focalRowKey = null
            this._coneSide = null
          }
        }}
        @click=${(e: MouseEvent) => { e.stopPropagation(); if (isCurrent) this._follow(w) }}
      >
        <div class="doc-tag">${w.otherTitle}</div>
        ${preview}
        <span class="pred">→ ${w.predicateLabel}</span>
      </div>
    `
  }

  /** Second-order fan (her 2026-10-14 ruling): NOT a list inside the card —
   * the target's own wires render as MINI CARDS on the far outside edge
   * (left stack's hover fans further left, right stack's further right;
   * fractal, small enough to be unwieldy, worth it for the feel). No previews,
   * no arrows, display-only (pointer-events none — they must not steal the
   * hover that summoned them). The wire that points back is omitted. */
  private _renderTertiary(lane: MspLaneData) {
    const hoveredId = this._hoveredId
    if (!hoveredId) return nothing
    let wire: MspWire | undefined
    let ownerBlockId: string | null = null
    outer: for (const w of lane.docWires) {
      if (w.id === hoveredId) { wire = w; break outer }
    }
    if (!wire) {
      for (const [blockId, wires] of lane.blockWires) {
        const found = wires.find(w => w.id === hoveredId)
        if (found) { wire = found; ownerBlockId = blockId; break }
      }
    }
    if (!wire) return nothing
    const w: MspWire = wire
    const targetLane = this._lane(w.otherDocId)
    if (!targetLane) return nothing
    const all = w.otherBlockId
      ? (targetLane.blockWires.get(w.otherBlockId) ?? [])
      : targetLane.docWires
    const wires = all.filter(sw => !(sw.otherDocId === lane.docId && (sw.otherBlockId ?? null) === ownerBlockId))
    if (wires.length === 0) return nothing
    const head = wires.slice(0, 8)
    const tail = wires.slice(8)
    // 'in' wires live in the left stack, so the fan goes further left, and
    // vice versa — outward, never back across the center. Past the eighth the
    // minis rest AFTER "+N more", hidden until it is hovered (2026-10-14).
    // Order matters: extras must appear BELOW the hovered chip — above it,
    // they push it out from under the pointer and the unfurl strobes.
    const side = w.direction === 'in' ? 'left' : 'right'
    return html`
      <div class="tertiary ${side}" @pointerleave=${() => { this._hoveredId = null; this._hoveredMiniId = null; this._focalRowKey = null; this._coneSide = null }}>
        ${head.map((sw) => html`
          <div
            class="mini-card"
            data-mini=${sw.id}
            data-parent=${w.id}
            title="Follow this wire"
            @pointerenter=${() => { this._hoveredMiniId = sw.id; this._scheduleLinks() }}
            @pointerleave=${() => { this._hoveredMiniId = null; this._scheduleLinks() }}
            @click=${(e: MouseEvent) => {
              e.stopPropagation()
              // Travel straight to the second-order target; the pan continues
              // outward the way the fan pointed (the parent wire's side).
              this._follow({ ...sw, direction: w.direction })
            }}
          >
            <div class="doc-tag">${sw.otherTitle}</div>
            <span class="pred">${sw.predicateLabel}</span>
          </div>
        `)}
        ${tail.length > 0 ? html`<div class="mini-card more" title="Hover to unfurl the rest">+ ${tail.length} more</div>` : nothing}
        ${tail.map((sw) => html`
          <div
            class="mini-card extra"
            data-mini=${sw.id}
            data-parent=${w.id}
            title="Follow this wire"
            @pointerenter=${() => { this._hoveredMiniId = sw.id; this._scheduleLinks() }}
            @pointerleave=${() => { this._hoveredMiniId = null; this._scheduleLinks() }}
            @click=${(e: MouseEvent) => {
              e.stopPropagation()
              this._follow({ ...sw, direction: w.direction })
            }}
          >
            <div class="doc-tag">${sw.otherTitle}</div>
            <span class="pred">${sw.predicateLabel}</span>
          </div>
        `)}
      </div>
    `
  }

  // ── Creation render ───────────────────────────────────────────────────────

  private _renderCreate() {
    const lane = this._lane(this._originDocId)
    const blocks = lane?.blocks ?? []
    const originIdx = blocks.findIndex(b => b.id === this._originBlockId)
    const origin = originIdx >= 0 ? blocks[originIdx] : null
    const above = originIdx > 0 ? blocks[originIdx - 1] : null
    const below = originIdx >= 0 && originIdx < blocks.length - 1 ? blocks[originIdx + 1] : null
    const targetLane = this._target ? this._lane(this._target.docId) : null
    const targetBlock = this._target?.blockId && targetLane
      ? targetLane.blocks.find(b => b.id === this._target!.blockId)
      : null
    const keysHint = this._phase === 'find'
      ? 'search or browse for the other end — clicking one brings the pair to center · Esc cancels'
      : 'scroll the ring or click away for relatesTo · Esc steps back'
    return html`
      <div class="veil ${this._leaving ? 'leaving' : ''}" @wheel=${(e: WheelEvent) => this._ringScroll(e)}>
        <div class="stage-head">
          <div><span class="mode-pill">Wire</span><span class="docname">${lane?.title ?? this.adapter.docTitle(this._originDocId)}</span></div>
          <div class="keys">${keysHint}</div>
          <button class="bar" @click=${() => this._goHome()}>Cancel</button>
        </div>
        ${this._phase === 'find' ? html`
          <div class="create-grid">
            <div class="ccol">
              <div class="ccol-title">Origin</div>
              <div class="card doc-card"><div class="doc-tag">Document</div>${lane?.title ?? '…'}</div>
              ${above ? html`<div class="card dim">${above.text}</div>` : nothing}
              ${origin
                ? html`<div class="card" style="border-color: var(--mn-color-accent, #6a7fdb)">${origin.text}</div>`
                : html`<div class="card" style="border-color: var(--mn-color-accent, #6a7fdb)"><em>whole document</em></div>`}
              ${below ? html`<div class="card dim">${below.text}</div>` : nothing}
            </div>
            <div class="ccol find-col">
              <div class="ccol-title">Find the other end</div>
              <input
                class="find-search"
                type="text"
                placeholder="Search blocks…"
                .value=${this._query}
                @input=${(e: InputEvent) => this._onQueryInput((e.target as HTMLInputElement).value)}
              />
              ${this._query.trim().length >= 2 ? this._renderSearchResults() : this._renderBrowse()}
            </div>
          </div>
        ` : html`
          <div class="craft-stage">
            <button class="bar craft-back" @click=${() => this._backToFind()}>← find again</button>
            <div class="craft-col">
              <div class="card doc-card"><div class="doc-tag">Origin</div>${lane?.title ?? '…'}</div>
              <div class="card origin-anchor" style="border-color: var(--mn-color-accent, #6a7fdb)">${origin?.text ?? html`<em>whole document</em>`}</div>
            </div>
            <button class="flip craft-flip" title="Flip wire direction" @click=${() => { this._direction = this._direction === 'out' ? 'in' : 'out' }}>⇄</button>
            ${!this._ring && !this._forming && !this._settling ? html`
              <button class="craft-reopen" @click=${(e: MouseEvent) => { this._ring = { x: e.clientX, y: e.clientY, sel: -1 } }}>choose the relation…</button>
            ` : nothing}
            <div class="craft-col">
              <div class="card doc-card"><div class="doc-tag">Target</div>${this._target ? this.adapter.docTitle(this._target.docId) : ''}</div>
              <div class="card target-anchor" style="border-color: var(--mn-color-accent, #6a7fdb)">${targetBlock?.text ?? html`<em>whole document</em>`}</div>
            </div>
          </div>
        `}
        ${this._renderArc()}
        ${this._renderRing()}
      </div>
    `
  }

  private _onQueryInput(value: string) {
    this._query = value
    const q = value.trim()
    if (q.length < 2) { this._searchHits = []; this._searching = false; return }
    const seq = ++this._searchSeq
    this._searching = true
    void this.adapter.searchBlocks(q).then(hits => {
      if (seq !== this._searchSeq) return
      this._searchHits = hits
      this._searching = false
    }).catch(() => { if (seq === this._searchSeq) this._searching = false })
  }

  private _renderSearchResults() {
    if (this._searching && this._searchHits.length === 0) {
      return html`<div class="target-empty">Searching…</div>`
    }
    if (this._searchHits.length === 0) {
      return html`<div class="target-empty">Nothing matches “${this._query}”.</div>`
    }
    const byDoc = new Map<string, { title: string; hits: MspSearchHit[] }>()
    for (const hit of this._searchHits) {
      const g = byDoc.get(hit.docId) ?? { title: hit.docTitle, hits: [] }
      g.hits.push(hit)
      byDoc.set(hit.docId, g)
    }
    return html`
      ${Array.from(byDoc.values()).map(g => html`
        <div class="result-doc">${g.title}</div>
        ${g.hits.map(h => html`
          <div class="find-block ${this._target?.blockId === h.blockId && this._target?.docId === h.docId ? 'picked' : ''}">
            <span @click=${() => this._pickTarget(h.docId, h.blockId)}>${h.text}</span>
            <button class="wirebtn" @click=${() => this._pickTarget(h.docId, h.blockId)}>wire</button>
          </div>
        `)}
      `)}
    `
  }

  private _renderBrowse() {
    const docs = this.adapter.listDocs()
    return html`
      ${this._candidates.length > 0 ? html`
        <div class="cand-head">Potentially related <span class="dashnote">— proximity, not wires; choosing one still asks you the predicate</span></div>
        ${this._candidates.map(c => html`
          <div class="card candidate cand-mini" @click=${() => this._pickTarget(c.docId, c.blockId)}>
            <div class="doc-tag">${c.docTitle} · candidate</div>
            ${c.text}
          </div>
        `)}
      ` : nothing}
      ${docs.map(d => this._renderFindDoc(d))}
    `
  }

  private _renderFindDoc(d: { id: string; title: string }) {
    const open = this._findDocId === d.id
    const blocks = open ? this._findBlocks.get(d.id) : undefined
    return html`
      <div
        class="find-doc ${open ? 'open' : ''}"
        @pointerenter=${() => { this._findDocId = d.id }}
      >
        <span>${d.title}</span>
        <span class="row-actions">
          <button
            class="wirebtn"
            title="Wire to this whole document (no block load)"
            @click=${(e: MouseEvent) => { e.stopPropagation(); this._pickTarget(d.id, null) }}
          >wire doc</button>
          <button
            class="chevbtn"
            title="Open this document's blocks"
            @click=${(e: MouseEvent) => {
              e.stopPropagation()
              if (!this._findBlocks.has(d.id)) {
                void this.adapter.loadBlocks(d.id).then(blocks => {
                  this._findBlocks = new Map(this._findBlocks).set(d.id, blocks)
                }).catch(() => undefined)
              }
            }}
          >›</button>
        </span>
      </div>
      ${open ? html`
        <div class="find-blocks">
          ${blocks === undefined
            ? html`<div class="target-empty">› to open this document's blocks — or “wire doc” for the whole thing</div>`
            : blocks.map(b => html`
                <div class="find-block ${this._target?.blockId === b.id && this._target?.docId === d.id ? 'picked' : ''}">
                  <span @click=${() => this._pickTarget(d.id, b.id)}>${b.text}</span>
                  <button class="wirebtn" @click=${() => this._pickTarget(d.id, b.id)}>wire</button>
                </div>
              `)}
        </div>
      ` : nothing}
    `
  }

  private _renderArc() {
    if (!this._forming) return nothing
    const f = this._forming
    const targetLane = this._target ? this._lane(this._target.docId) : null
    const neighbors = this._settling && targetLane
      ? targetLane.blocks.filter(b => b.id !== this._target!.blockId).slice(0, 2)
      : []
    return html`
      <svg class="arc-layer">
        <path
          class="forming"
          d=${f.d}
          style="stroke-dasharray: ${f.len}; stroke-dashoffset: ${f.len}; animation: draw-arc ${TIMINGS.arc}ms ease-out forwards"
        ></path>
        <style>@keyframes draw-arc { to { stroke-dashoffset: 0; } }</style>
      </svg>
      <div class="arc-label" style="left:${f.lx}px; top:${f.ly}px">${f.label}</div>
      ${neighbors.map((b, i) => html`
        <div class="settle-chip" style="left: calc(66% + ${18 + i * 12}px); top: ${38 + i * 14}%; animation-delay: ${i * 90}ms">
          <div class="doc-tag" style="font-size:0.56rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;opacity:0.5">settles near</div>
          ${b.text}
        </div>
      `)}
    `
  }

  private _renderRing() {
    if (!this._ring) return nothing
    const r = this._ring
    const radius = 104
    const items = MSP_RING_PREDICATES.map((p, i) => {
      const angle = (i / MSP_RING_PREDICATES.length) * 2 * Math.PI - Math.PI / 2
      return { p, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, i }
    })
    return html`
      <div class="ring-backdrop" @click=${() => void this._commitWire('relatesTo')}></div>
      <div class="ring-wrap" style="left:${r.x}px; top:${r.y}px">
        ${items.map(it => html`
          <div
            class="ring-item ${r.sel === it.i ? 'sel' : ''}"
            style="left: ${it.x}px; top: ${it.y}px"
            @click=${(e: MouseEvent) => { e.stopPropagation(); void this._commitWire(it.p) }}
          >${it.p}</div>
        `)}
        <button
          class="ring-center"
          @click=${(e: MouseEvent) => { e.stopPropagation(); void this._commitWire('relatesTo') }}
        >${r.sel >= 0 ? MSP_RING_PREDICATES[r.sel] : 'relatesTo'}</button>
        <div class="ring-hint">scroll to cycle · center or click-away = relatesTo</div>
      </div>
    `
  }
}

const MSP_RING_PREDICATES = [
  'supports',
  'contradicts',
  'qualifies',
  'exemplifies',
  'grounds',
  'flowsInto',
  'intensifiesWith',
] as const

export { MSP_RING_PREDICATES }

declare global {
  interface HTMLElementTagNameMap {
    'msp-live-stage': MspLiveStage
  }
}
