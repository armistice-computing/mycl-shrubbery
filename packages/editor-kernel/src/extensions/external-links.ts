/**
 * external-links.ts — a link in a document opens in the browser.
 *
 * StarterKit's Link runs with openOnClick:false, so a click places the caret
 * for editing, as in every editor. Nothing opened a link at all (friction
 * triage, 2026-11-16): web links and imported markdown links were dead.
 *
 * The rule, as Notion, Google Docs and Apple Notes do it:
 *   - Command-click opens a link, always.
 *   - A plain click opens it when the document is read-only (imported notes
 *     arrive read-only), since there's no caret to place.
 * Hovering a link says which gesture opens it. Only web and mail links open;
 * the host decides how (the desktop app's opener, or a new browser tab).
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

export const externalLinksKey = new PluginKey('externalLinks')

export interface ExternalLinksOptions {
  /** The host opens the URL. Without one, nothing opens. */
  onOpen?: (href: string) => void
}

const OPENABLE = /^(https?:|mailto:)/i

/** The openable href of the link under a click target, or null. */
export function openableHref(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('a[href]') : null
  const href = element?.getAttribute('href')?.trim() ?? ''
  return OPENABLE.test(href) ? href : null
}

/** Whether this click should open the link rather than place the caret. */
export function opensLink(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'button'>, editable: boolean): boolean {
  if (event.button !== 0) return false
  return event.metaKey || event.ctrlKey || !editable
}

export const ExternalLinks = Extension.create<ExternalLinksOptions>({
  name: 'externalLinks',

  addOptions() {
    return { onOpen: undefined }
  },

  addProseMirrorPlugins() {
    const onOpen = this.options.onOpen
    return [
      new Plugin({
        key: externalLinksKey,
        props: {
          handleDOMEvents: {
            mouseover: (view, event) => {
              const element = event.target instanceof Element ? event.target.closest('a[href]') : null
              if (!element || !openableHref(element)) return false
              const hint = view.editable ? '⌘-click to open' : 'Click to open'
              const href = element.getAttribute('href') ?? ''
              element.setAttribute('title', `${href} · ${hint}`)
              return false
            },
          },
          handleClick: (view, _pos, event) => {
            if (!onOpen) return false
            const href = openableHref(event.target)
            if (!href || !opensLink(event, view.editable)) return false
            event.preventDefault()
            onOpen(href)
            return true
          },
        },
      }),
    ]
  },
})
