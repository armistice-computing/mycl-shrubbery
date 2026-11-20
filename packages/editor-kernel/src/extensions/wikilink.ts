/**
 * TipTap WikiLink Extension
 *
 * Provides Roam/Obsidian-style [[wiki-links]] for inline document references.
 * Links can target entire documents or specific blocks within documents.
 *
 * Usage:
 *   editor.commands.insertWikiLink({
 *     targetDocId: 'doc-123',
 *     label: 'My Document',
 *     wireId: 'wire-abc',
 *   })
 *
 * Renders as: [[My Document]] or [[My Document > Block preview...]]
 *
 * Features:
 * - Inline atomic node (can't place cursor inside)
 * - Click navigates to target document/block
 * - Hover shows preview tooltip
 * - Stores wireId for automatic cleanup on deletion
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { OPEN_WIKILINK_PICKER_EVENT } from './wikilink-autocomplete'

export interface WikiLinkOptions {
  HTMLAttributes: Record<string, unknown>
  /** Host-owned explicit picker intent (Mod/Ctrl-Shift-K). */
  onOpenPicker?: () => void
  /**
   * Preserve the historical ownerDocument CustomEvent when no callback is
   * supplied. Composer profiles disable this; direct/document use stays true.
   */
  emitLegacyPickerEvents: boolean
  /** Called when a wikilink is clicked; `element` is the chip, for placing a popover. */
  onWikiLinkClick?: (attrs: WikiLinkAttrs, element?: HTMLElement) => void
  /** Called when a wikilink is deleted */
  onWikiLinkDelete?: (attrs: WikiLinkAttrs) => void
}

export interface WikiLinkAttrs {
  /** Target document ID (required) */
  targetDocId: string
  /** Optional target block ID for block-level links */
  targetBlockId?: string | null
  /** Target graph ID (default: current graph) */
  targetGraphId?: string | null
  /** Display label (document title) */
  label: string
  /** Block text preview for block-level links (~50 chars) */
  blockPreview?: string | null
  /** Wire ID for cleanup on deletion */
  wireId?: string | null
  /**
   * File links (`[[path#L10-L20]]`): the file's record id, the path as linked,
   * and the region's short form. A file link carries an empty targetDocId.
   */
  targetArtifactId?: string | null
  filePath?: string | null
  region?: string | null
}

/** True for a link to lines (or a page) of a file rather than to a document. */
export function isFileLink(attrs: Pick<WikiLinkAttrs, 'filePath' | 'targetArtifactId'>): boolean {
  return Boolean(attrs.filePath || attrs.targetArtifactId)
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikilink: {
      /**
       * Insert a wikilink at the current cursor position
       */
      insertWikiLink: (attrs: WikiLinkAttrs) => ReturnType
    }
  }
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikilink',

  addOptions() {
    return {
      HTMLAttributes: {},
      onOpenPicker: undefined,
      emitLegacyPickerEvents: true,
      onWikiLinkClick: undefined,
      onWikiLinkDelete: undefined,
    }
  },

  // Inline node that acts as a single unit
  group: 'inline',
  inline: true,
  atom: true, // Can't place cursor inside

  addAttributes() {
    return {
      targetDocId: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-target-doc-id') ||
          element.getAttribute('targetDocId') ||
          null,
        renderHTML: (attributes) => ({
          'data-target-doc-id': attributes.targetDocId,
        }),
      },
      targetBlockId: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-target-block-id') ||
          element.getAttribute('targetBlockId') ||
          null,
        renderHTML: (attributes) =>
          attributes.targetBlockId
            ? { 'data-target-block-id': attributes.targetBlockId }
            : {},
      },
      targetGraphId: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-target-graph-id') ||
          element.getAttribute('targetGraphId') ||
          null,
        renderHTML: (attributes) =>
          attributes.targetGraphId
            ? { 'data-target-graph-id': attributes.targetGraphId }
            : {},
      },
      label: {
        default: 'Untitled',
        parseHTML: (element) =>
          element.getAttribute('data-label') ||
          element.getAttribute('label') ||
          element.textContent?.replace(/^\[\[|\]\]$/g, '') ||
          'Untitled',
        renderHTML: (attributes) => ({
          'data-label': attributes.label,
        }),
      },
      blockPreview: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-block-preview') ||
          element.getAttribute('blockPreview') ||
          null,
        renderHTML: (attributes) =>
          attributes.blockPreview
            ? { 'data-block-preview': attributes.blockPreview }
            : {},
      },
      wireId: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-wire-id') ||
          element.getAttribute('wireId') ||
          null,
        renderHTML: (attributes) =>
          attributes.wireId ? { 'data-wire-id': attributes.wireId } : {},
      },
      targetArtifactId: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-target-artifact-id') ||
          element.getAttribute('targetArtifactId') ||
          null,
        renderHTML: (attributes) =>
          attributes.targetArtifactId
            ? { 'data-target-artifact-id': attributes.targetArtifactId }
            : {},
      },
      filePath: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-file-path') ||
          element.getAttribute('filePath') ||
          null,
        renderHTML: (attributes) =>
          attributes.filePath ? { 'data-file-path': attributes.filePath } : {},
      },
      region: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-region') ||
          element.getAttribute('region') ||
          null,
        renderHTML: (attributes) =>
          attributes.region ? { 'data-region': attributes.region } : {},
      },
    }
  },

  parseHTML() {
    return [
      {
        // Frontend renders as span.wikilink
        tag: 'span.wikilink',
      },
      {
        // Backend/MCP sends as <wikilink> element
        tag: 'wikilink',
        getAttrs: (element: HTMLElement) => ({
          targetDocId: element.getAttribute('data-target-doc-id'),
          targetBlockId: element.getAttribute('data-target-block-id'),
          targetGraphId: element.getAttribute('data-target-graph-id'),
          label: element.getAttribute('data-label') || element.textContent,
          blockPreview: element.getAttribute('data-block-preview'),
          wireId: element.getAttribute('data-wire-id'),
          targetArtifactId: element.getAttribute('data-target-artifact-id'),
          filePath: element.getAttribute('data-file-path'),
          region: element.getAttribute('data-region'),
        }),
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const label = HTMLAttributes['data-label'] || 'Untitled'
    const blockPreview = HTMLAttributes['data-block-preview']
    const hasBlock = !!HTMLAttributes['data-target-block-id']

    // A file link reads as a chip, "notes.md · lines 10–20", not as [[brackets]].
    if (HTMLAttributes['data-file-path'] || HTMLAttributes['data-target-artifact-id']) {
      return [
        'span',
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
          class: 'wikilink wikilink-file',
          tabindex: '0',
          role: 'link',
        }),
        label,
      ]
    }

    // Format: [[Doc]], or for a block [[Its text, cut at 30…]], so a link
    // reads as the words it points at: "Because [[Information is alive.]]"
    // (Eschaton, 2026-10-09; it used to read [[>>…]]).
    let displayText = `[[${label}]]`
    if (hasBlock && blockPreview) {
      const truncatedPreview =
        blockPreview.length > 30 ? blockPreview.slice(0, 30) + '…' : blockPreview
      displayText = `[[${truncatedPreview}]]`
    }

    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: `wikilink ${hasBlock ? 'wikilink-block' : ''}`,
        tabindex: '0',
        role: 'link',
      }),
      displayText,
    ]
  },

  /** Canonical plain-text form used by getText/clipboard/chat serialization. */
  renderText({ node }) {
    const filePath = node.attrs.filePath as string | null
    const region = node.attrs.region as string | null
    if (filePath) {
      return region ? `[[${filePath}#${region}]]` : `[[${filePath}]]`
    }
    const label = String(node.attrs.label ?? 'Untitled')
    // A file picked by name has no path: its label is "notes.md · lines 2–3".
    if (node.attrs.targetArtifactId) {
      const name = label.split(' · ')[0] || label
      return region ? `[[${name}#${region}]]` : `[[${name}]]`
    }
    return `[[${label}]]`
  },

  addCommands() {
    return {
      insertWikiLink:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              targetDocId: attrs.targetDocId,
              targetBlockId: attrs.targetBlockId || null,
              targetGraphId: attrs.targetGraphId || null,
              label: attrs.label,
              blockPreview: attrs.blockPreview || null,
              wireId: attrs.wireId || null,
              targetArtifactId: attrs.targetArtifactId || null,
              filePath: attrs.filePath || null,
              region: attrs.region || null,
            },
          })
        },
    }
  },

  // Add keyboard handling
  addKeyboardShortcuts() {
    return {
      // Cmd/Ctrl + Shift + K to insert wikilink (opens picker)
      'Mod-Shift-k': () => {
        if (this.options.onOpenPicker) {
          this.options.onOpenPicker()
        } else if (this.options.emitLegacyPickerEvents) {
          // Backward-compatible document-editor seam, scoped to this editor's
          // owner document rather than the ambient global document.
          this.editor.view.dom.ownerDocument.dispatchEvent(
            new CustomEvent(OPEN_WIKILINK_PICKER_EVENT),
          )
        }
        return true
      },
    }
  },

  // Plugin to handle click navigation and hover tooltips
  addProseMirrorPlugins() {
    const extension = this

    return [
      new Plugin({
        key: new PluginKey('wikilinkInteraction'),
        props: {
          handleDOMEvents: {
            // Handle clicks on wikilinks
            click: (_view, event) => {
              const target = event.target as HTMLElement
              if (target.classList.contains('wikilink')) {
                event.preventDefault()
                event.stopPropagation()

                const attrs: WikiLinkAttrs = {
                  targetDocId: target.getAttribute('data-target-doc-id') || '',
                  targetBlockId: target.getAttribute('data-target-block-id'),
                  targetGraphId: target.getAttribute('data-target-graph-id'),
                  label: target.getAttribute('data-label') || '',
                  blockPreview: target.getAttribute('data-block-preview'),
                  wireId: target.getAttribute('data-wire-id'),
                  targetArtifactId: target.getAttribute('data-target-artifact-id'),
                  filePath: target.getAttribute('data-file-path'),
                  region: target.getAttribute('data-region'),
                }

                extension.options.onWikiLinkClick?.(attrs, target)
                return true
              }
              return false
            },

            // Show tooltip on hover
            mouseover: (_view, event) => {
              const target = event.target as HTMLElement
              if (target.classList.contains('wikilink')) {
                const filePath = target.getAttribute('data-file-path')
                if (filePath || target.getAttribute('data-target-artifact-id')) {
                  target.setAttribute('title', filePath || target.getAttribute('data-label') || '')
                  return false
                }
                const label = target.getAttribute('data-label') || 'Untitled'
                const blockPreview = target.getAttribute('data-block-preview')
                const tooltip = blockPreview
                  ? `${label}\n\n${blockPreview}`
                  : `Open: ${label}`
                target.setAttribute('title', tooltip)
              }
              return false
            },
          },
        },
      }),
    ]
  },
})

/**
 * CSS styles for wikilinks - include in your component styles
 */
export const wikilinkStyles = `
  .wikilink {
    color: var(--mn-color-text-accent);
    text-decoration: underline;
    text-decoration-style: dotted;
    text-decoration-color: var(--mn-color-text-accent);
    cursor: pointer;
    border-radius: 2px;
    padding: 0 2px;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .wikilink:hover {
    background: var(--mn-color-surface-accent);
    text-decoration-style: solid;
    text-decoration-color: var(--mn-color-text-accent);
  }

  .wikilink:focus {
    outline: 2px solid var(--mn-color-border-focus);
    outline-offset: 1px;
  }

  /* A link to lines of a file: a quiet chip with a file mark before it. */
  .wikilink-file {
    text-decoration: none;
    font-family: var(--mn-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.88em;
    padding: 1px 6px 1px 18px;
    border: 1px solid var(--mn-color-border-subtle, rgba(0, 0, 0, 0.12));
    border-radius: 4px;
    background: var(--mn-color-surface-sunken, rgba(0, 0, 0, 0.03));
    position: relative;
  }

  .wikilink-file::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 50%;
    width: 9px;
    height: 11px;
    transform: translateY(-50%);
    border: 1.25px solid currentColor;
    border-radius: 1.5px;
    opacity: 0.7;
  }

  .wikilink-file:hover {
    text-decoration: none;
  }

  /* Block-level wikilink styling */
  .wikilink-block {
    font-style: italic;
  }

  /* Selection state */
  .wikilink.ProseMirror-selectednode {
    background: var(--mn-color-surface-accent);
    outline: 2px solid var(--mn-color-border-accent);
  }
`

export default WikiLink
