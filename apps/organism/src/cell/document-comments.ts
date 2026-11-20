/**
 * document-comments.ts — shell-side comments metadata adapter.
 *
 * Garden stores comment metadata in the open document Y.Doc's `comments` Y.Map;
 * the editor mark stores only `commentId`. Shrubbery keeps the same persistence
 * model here, in the concrete app shell, and projects it into backend-free
 * `mn-comments-panel` props through renderWorkspace.
 */

import * as Y from 'yjs'
import type { ReactiveSource } from '@shrubbery/nucleus'
import type { WorkspaceComment } from '@shrubbery/runtime'

export interface DocumentCommentData {
  readonly text: string
  /**
   * OPTIONAL because the shell is not the only writer into this map. Every
   * comment `main.ts` creates is stamped `'You'`/`'local'`
   * (`localCommentAuthor`), so an entry that reaches us WITHOUT an author was
   * written by something else — an agent through MCP, or an import carried in
   * from cloud-1. Typing it `string` claimed a guarantee the map does not
   * make, which is how the `|| 'Anonymous'` fallback below came to look
   * defensive rather than inventive.
   */
  readonly author?: string
  readonly authorId?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly resolved: boolean
  readonly quotedText?: string
  readonly documentPosition?: number
  readonly blockId?: string
}

export interface DocumentCommentsSource extends ReactiveSource<readonly WorkspaceComment[]> {
  set(commentId: string, data: DocumentCommentData): void
  update(commentId: string, patch: Partial<DocumentCommentData>): boolean
  delete(commentId: string): boolean
  commentsMap(): Y.Map<DocumentCommentData>
  destroy(): void
}

function asYDoc(doc: unknown): Pick<Y.Doc, 'getMap'> {
  const candidate = doc as { getMap?: unknown } | null
  if (!candidate || typeof candidate.getMap !== 'function') {
    throw new Error('createDocumentCommentsSource: provider doc does not expose Y.Doc#getMap')
  }
  return candidate as Pick<Y.Doc, 'getMap'>
}

/**
 * An absent author stays absent. The old fallback here was `'Anonymous'` — a
 * multi-tenant word for an unidentified STRANGER, and on a one-owner node
 * there is no stranger: the shell stamps `'You'` on everything it writes, so
 * the only entries that reach this branch were written by one of our agents
 * or carried in by an import. Naming them "Anonymous" turns a missing field
 * into an assertion about a person who does not exist.
 *
 * Same rule the inspector's chronicle rows already follow: a missing author
 * renders as a BARE DATE, never a guess. The two comment surfaces both reach
 * that, but by DIFFERENT routes, and the difference is worth knowing before
 * editing either:
 *
 *   · `mn-comments-panel` keeps the span and renders it empty. Harmless
 *     because `.comment-date` is `margin-left: auto` — the date still lands
 *     against the right edge, so a zero-width author leaves no visible seam.
 *   · `mn-comment-popover` DROPS the byline node. It has to: that header
 *     stacks author OVER time, so an empty div would hold open a blank line
 *     above the date rather than collapsing.
 *
 * Both are asserted by their own tests; neither is assumed from the other.
 */
function workspaceCommentFromEntry(id: string, data: DocumentCommentData): WorkspaceComment {
  return {
    id,
    author: (data.author ?? '').trim(),
    text: data.text ?? '',
    quotedText: data.quotedText ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    resolved: data.resolved,
    documentPosition: data.documentPosition ?? null,
    blockId: data.blockId ?? null,
  }
}

export function commentsFromYMap(comments: Y.Map<DocumentCommentData>): readonly WorkspaceComment[] {
  return Array.from(comments.entries()).map(([id, data]) => workspaceCommentFromEntry(id, data))
}

export function createDocumentCommentsSource(doc: unknown): DocumentCommentsSource {
  const comments = asYDoc(doc).getMap<DocumentCommentData>('comments')
  const subscribers = new Set<(comments: readonly WorkspaceComment[]) => void>()
  const notify = (): void => {
    const snapshot = commentsFromYMap(comments)
    for (const subscriber of subscribers) subscriber(snapshot)
  }
  const observer = (): void => notify()
  comments.observe(observer)

  return {
    get: () => commentsFromYMap(comments),
    subscribe(cb) {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    set(commentId, data) {
      comments.set(commentId, data)
    },
    update(commentId, patch) {
      const existing = comments.get(commentId)
      if (!existing) return false
      comments.set(commentId, { ...existing, ...patch })
      return true
    },
    delete(commentId) {
      const existed = comments.has(commentId)
      comments.delete(commentId)
      return existed
    },
    commentsMap: () => comments,
    destroy() {
      comments.unobserve(observer)
      subscribers.clear()
    },
  }
}
