/**
 * comment-popover-layer.ts — the floating comment popovers over the editor,
 * ported from cloud-1's document-editor (renderCommentPopovers and the pin
 * handlers around createCommentInline).
 *
 * Behavior, as cloud-1 had it:
 *   - hovering a comment mark shows a PEEK popover (read-only, desktop only);
 *   - clicking a mark PINS a popover (editable, draggable, closed with its X);
 *     clicking a pinned one brings it to the front;
 *   - double-clicking a mark clears every pin and opens the Comments panel;
 *   - a NEW comment is pinned at once in EDIT mode, so you type straight into
 *     it. It does not open the Comments panel.
 *   - while the Comments panel is open, the panel shows comments: no peek, and
 *     a click selects the comment in the panel instead of pinning it.
 *
 * One addition: closing a new comment that was never given text deletes it,
 * with its mark, so an abandoned "Add comment" leaves nothing behind.
 *
 * Easier to dismiss (Eschaton, 2026-10-14): saving a new comment closes its
 * popover; Escape closes the top popover; a click anywhere outside the
 * popovers closes them all. A popover holding unsaved words stays open, and
 * so does a new comment not yet written (a stray click must not delete it).
 * A press on a comment's own mark is left to the mark's click, which pins it.
 *
 * The editor host reports pointer events on marks (EDITOR_COMMENT_POINTER_EVENT)
 * and never renders comment chrome itself. Comment data stays in the shell's
 * comments source; this layer only holds which popovers are open and where.
 * Popovers render into one fixed-position container on document.body, so the
 * anchors are viewport coordinates.
 */
import { html, render, nothing } from 'lit'
import type { EditorCommentAnchor, EditorCommentPointerDetail } from '@shrubbery/runtime'
import type { MnCommentPopoverComment } from '@shrubbery/components'

export interface CommentPopoverData extends MnCommentPopoverComment {
  readonly quotedText?: string | null
}

export interface CommentPopoverLayerOptions {
  readonly doc: Document
  /** The comment's current data, or null when it no longer exists. */
  readonly comment: (commentId: string) => CommentPopoverData | null
  readonly isPanelOpen: () => boolean
  readonly onSave: (commentId: string, text: string) => void
  readonly onResolve: (commentId: string) => void
  /** Delete the comment and its mark. */
  readonly onDelete: (commentId: string) => void
  /** Paint (or clear, with null) the comment's text as active in the editor. */
  readonly onHighlight: (commentId: string | null) => void
  /** A click while the panel is open: select the comment there. */
  readonly onSelectInPanel: (commentId: string) => void
  /** A double click: open the Comments panel on this comment. */
  readonly onOpenPanel: (commentId: string) => void
}

export class CommentPopoverLayer {
  private readonly container: HTMLElement
  private hoveredId: string | null = null
  private hoverAnchor: EditorCommentAnchor = { x: 0, y: 0 }
  /** Pinned ids, oldest first: the last one is drawn on top. */
  private pinnedIds: string[] = []
  private readonly positions = new Map<string, EditorCommentAnchor>()
  /** The new comment whose popover opens in edit mode. */
  private newCommentId: string | null = null

  constructor(private readonly options: CommentPopoverLayerOptions) {
    this.container = options.doc.createElement('div')
    this.container.className = 'organism-comment-popovers'
    this.container.dataset.commentPopoverLayer = ''
    options.doc.body.append(this.container)
    options.doc.addEventListener('pointerdown', this.onPointerDown, true)
    // Capture: the editor's own Escape (select the block) would otherwise take
    // the key first whenever the editor has focus, which it does after a click
    // on a mark.
    options.doc.addEventListener('keydown', this.onKeyDown, true)
  }

  /** A press outside every popover closes the pinned ones. */
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.pinnedIds.length === 0) return
    const inside = event.composedPath().some(node => node instanceof Element
      ? node.tagName === 'MN-COMMENT-POPOVER' || node.hasAttribute('data-comment-id')
      : false)
    if (inside) return
    for (const commentId of [...this.pinnedIds]) {
      if (commentId === this.newCommentId || this.isDirty(commentId)) continue
      this.close(commentId)
    }
  }

  /** Escape closes the top pinned popover. In its text box, Escape cancels the edit instead. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    // Inside a popover, its own Escape cancels the edit.
    if (event.composedPath().some(node => node instanceof Element ? node.tagName === 'MN-COMMENT-POPOVER' : false)) return
    const top = this.topPinnedId()
    if (!top || this.isDirty(top)) return
    event.preventDefault()
    event.stopPropagation()
    this.close(top)
  }

  private isDirty(commentId: string): boolean {
    const popover = this.container.querySelector(`mn-comment-popover[comment-id="${CSS.escape(commentId)}"]`) as
      (HTMLElement & { dirty?: boolean }) | null
    return popover?.dirty === true
  }

  /** Route one pointer event from the editor host. */
  pointer(detail: EditorCommentPointerDetail): void {
    const { commentId, action, anchor } = detail
    if (action === 'enter') {
      this.hoveredId = commentId
      this.hoverAnchor = anchor
      this.options.onHighlight(commentId)
    } else if (action === 'leave') {
      if (this.hoveredId === commentId) this.hoveredId = null
      this.options.onHighlight(this.topPinnedId())
    } else if (action === 'click') {
      if (this.options.isPanelOpen()) {
        this.options.onSelectInPanel(commentId)
        return
      }
      this.pin(commentId, anchor)
      if (this.hoveredId === commentId) this.hoveredId = null
    } else {
      this.clear()
      this.options.onOpenPanel(commentId)
      return
    }
    this.render()
  }

  /** Pin a just-created comment in edit mode. */
  pinNew(commentId: string, anchor: EditorCommentAnchor | null): void {
    this.newCommentId = commentId
    this.pin(commentId, anchor ?? this.fallbackAnchor())
    this.render()
  }

  /** Comments changed: redraw, and drop pins whose comment is gone. */
  refresh(): void {
    const live = this.pinnedIds.filter(id => this.options.comment(id) != null)
    if (live.length !== this.pinnedIds.length) {
      for (const id of this.pinnedIds) if (!live.includes(id)) this.positions.delete(id)
      this.pinnedIds = live
    }
    if (this.hoveredId && !this.options.comment(this.hoveredId)) this.hoveredId = null
    if (this.newCommentId && !this.pinnedIds.includes(this.newCommentId)) this.newCommentId = null
    this.render()
  }

  /** Close everything: the document changed, or the panel took over. */
  clear(): void {
    this.hoveredId = null
    this.pinnedIds = []
    this.positions.clear()
    this.newCommentId = null
    this.render()
  }

  destroy(): void {
    this.options.doc.removeEventListener('pointerdown', this.onPointerDown, true)
    this.options.doc.removeEventListener('keydown', this.onKeyDown, true)
    render(nothing, this.container)
    this.container.remove()
  }

  private pin(commentId: string, anchor: EditorCommentAnchor): void {
    if (!this.pinnedIds.includes(commentId)) this.positions.set(commentId, anchor)
    this.pinnedIds = [...this.pinnedIds.filter(id => id !== commentId), commentId]
    this.options.onHighlight(commentId)
  }

  private unpin(commentId: string): void {
    this.pinnedIds = this.pinnedIds.filter(id => id !== commentId)
    this.positions.delete(commentId)
    if (this.newCommentId === commentId) this.newCommentId = null
    this.options.onHighlight(this.topPinnedId())
  }

  private topPinnedId(): string | null {
    return this.pinnedIds[this.pinnedIds.length - 1] ?? null
  }

  private fallbackAnchor(): EditorCommentAnchor {
    const view = this.options.doc.defaultView
    return { x: (view?.innerWidth ?? 800) / 2 - 160, y: (view?.innerHeight ?? 600) / 3 }
  }

  private close(commentId: string): void {
    const abandoned = this.newCommentId === commentId && !(this.options.comment(commentId)?.text ?? '').trim()
    this.unpin(commentId)
    if (abandoned) this.options.onDelete(commentId)
    this.render()
  }

  private save(commentId: string, text: string): void {
    const wasNew = this.newCommentId === commentId
    if (wasNew) this.newCommentId = null
    this.options.onSave(commentId, text)
    // A new comment is done once written: its popover goes.
    if (wasNew) {
      this.unpin(commentId)
      this.render()
    }
  }

  private remove(commentId: string): void {
    this.unpin(commentId)
    this.options.onDelete(commentId)
    this.render()
  }

  private moveTo(commentId: string, anchor: EditorCommentAnchor): void {
    this.positions.set(commentId, anchor)
    this.render()
  }

  private bringToFront(commentId: string): void {
    if (this.topPinnedId() === commentId) return
    this.pinnedIds = [...this.pinnedIds.filter(id => id !== commentId), commentId]
    this.options.onHighlight(commentId)
    this.render()
  }

  private render(): void {
    const panelOpen = this.options.isPanelOpen()
    const peekId = !panelOpen && this.hoveredId && !this.pinnedIds.includes(this.hoveredId)
      ? this.hoveredId
      : null
    const peek = peekId ? this.options.comment(peekId) : null
    const pinned = this.pinnedIds
    // The wrapping element is for happy-dom, which renders a child part at the
    // very top of a template as a literal "<?>".
    render(
      html`<div class="organism-comment-popover-stack">
        ${peek && peekId
          ? html`<mn-comment-popover
              comment-id=${peekId}
              .comment=${peek}
              .quotedText=${peek.quotedText ?? ''}
              mode="peek"
              .x=${this.hoverAnchor.x}
              .y=${this.hoverAnchor.y}
              .zIndex=${950}
            ></mn-comment-popover>`
          : nothing}
        ${pinned.map((commentId, index) => {
          const comment = this.options.comment(commentId)
          const position = this.positions.get(commentId)
          if (!comment || !position) return nothing
          return html`<mn-comment-popover
            comment-id=${commentId}
            .comment=${comment}
            .quotedText=${comment.quotedText ?? ''}
            mode="pinned"
            .x=${position.x}
            .y=${position.y}
            .zIndex=${900 + index + 1}
            editable
            ?start-editing=${this.newCommentId === commentId}
            @mn-close=${() => this.close(commentId)}
            @mn-save=${(event: CustomEvent<{ text: string }>) => this.save(commentId, event.detail.text)}
            @mn-resolve=${() => this.options.onResolve(commentId)}
            @mn-delete=${() => this.remove(commentId)}
            @mn-focus=${() => this.bringToFront(commentId)}
            @mn-move=${(event: CustomEvent<EditorCommentAnchor>) =>
              this.moveTo(commentId, { x: event.detail.x, y: event.detail.y })}
          ></mn-comment-popover>`
        })}
      </div>`,
      this.container,
    )
  }
}
