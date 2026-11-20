/**
 * TipTap Image Block Extension
 *
 * Block-level void node for inline images in documents.
 * Images are stored in S3 and served via a stable proxy endpoint.
 *
 * Attributes:
 * - src: Stable proxy URL for the image
 * - alt: Alt text / description (also stored as RDF triple for agent access)
 * - title: Optional tooltip text
 *
 * Usage in TipTap:
 *   editor.chain().focus().insertImage({ src, alt }).run()
 *
 * XML representation:
 *   <image src="..." alt="..." data-block-id="block-xxx"/>
 *
 * DOM rendering uses a wrapper div so the wire dot (::before) works
 * — void elements like <img> can't have pseudo-elements.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { classifyImageSrc, type ImageResolver, type ResolvedImage } from './image-src'

export interface ImageBlockOptions {
  HTMLAttributes: Record<string, unknown>
  /**
   * Resolves stored images (`mycl-artifact://` and uploaded-image URLs) to an
   * object URL. Absent: those images show a placeholder. The kernel never
   * fetches an image itself.
   */
  resolveImage?: ImageResolver
}

/** Largest data: URL an image block renders: 10 MiB of bytes, base64-encoded. */
export const MAX_DATA_IMAGE_SRC_LENGTH = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 64

function syncWrapperAttrs(dom: HTMLElement, node: ProseMirrorNode): void {
  const blockId = node.attrs?.['data-block-id']
  if (typeof blockId === 'string' && blockId) dom.setAttribute('data-block-id', blockId)
  else dom.removeAttribute('data-block-id')
  dom.setAttribute('data-size', (node.attrs?.size as string) || 'large')
}

function altLabel(node: ProseMirrorNode): string {
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.trim() : ''
  return alt || 'image'
}

function placeholder(node: ProseMirrorNode, reason: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'image-block-placeholder'
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', `${altLabel(node)}: ${reason}`)
  const alt = document.createElement('span')
  alt.className = 'image-block-placeholder-alt'
  alt.textContent = altLabel(node)
  const why = document.createElement('span')
  why.className = 'image-block-placeholder-reason'
  why.textContent = reason
  el.append(alt, why)
  return el
}

const REASON_WEB = 'Not loaded: images from the web stay off.'
const REASON_UNSUPPORTED = "Can't be shown: this kind of image isn't supported."
const REASON_NOT_IMPORTED = 'Image not displayed. The original reference is kept.'
const REASON_FAILED = "Couldn't be loaded."
const REASON_NO_RESOLVER = "Can't be shown here."

export type ImageSize = 'small' | 'medium' | 'large'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    image: {
      insertImage: (attrs: { src: string; alt?: string; title?: string; size?: ImageSize }) => ReturnType
    }
  }
}

export const ImageBlock = Node.create<ImageBlockOptions>({
  name: 'image',

  addOptions() {
    return {
      HTMLAttributes: {},
      resolveImage: undefined,
    }
  },

  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (element) => {
          // Handle wrapper div: look for img child
          const img = element.tagName === 'IMG' ? element : element.querySelector('img')
          return img?.getAttribute('src') || element.getAttribute('src')
        },
        renderHTML: (attributes) => ({ src: attributes.src }),
      },
      alt: {
        default: '',
        parseHTML: (element) => {
          const img = element.tagName === 'IMG' ? element : element.querySelector('img')
          return img?.getAttribute('alt') || element.getAttribute('alt') || ''
        },
        renderHTML: (attributes) => ({ alt: attributes.alt }),
      },
      title: {
        default: null,
        parseHTML: (element) => {
          const img = element.tagName === 'IMG' ? element : element.querySelector('img')
          return img?.getAttribute('title') || element.getAttribute('title')
        },
        renderHTML: (attributes) =>
          attributes.title ? { title: attributes.title } : {},
      },
      size: {
        default: 'large' as ImageSize,
        parseHTML: (element) => element.getAttribute('data-size') || 'large',
        renderHTML: (attributes) => ({ 'data-size': attributes.size || 'large' }),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
      },
      {
        // Backend/MCP sends as <image> element
        tag: 'image[src]',
      },
      {
        // Wrapper div from our own renderHTML
        tag: 'div.image-block',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    // Separate image-specific attrs from global attrs (data-block-id, etc.)
    const { src, alt, title, ...globalAttrs } = HTMLAttributes
    // Wrapper div gets global attrs (data-block-id) + class for wire dot support
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, globalAttrs, { class: 'image-block' }),
      [
        'img',
        {
          src,
          alt: alt || '',
          ...(title ? { title } : {}),
          draggable: 'false',
        },
      ],
    ]
  },

  /**
   * The node view decides what loads (classifyImageSrc) and never rewrites the
   * persisted src. renderHTML above stays the serialized form, so documents,
   * copies and exports are unchanged.
   */
  addNodeView() {
    const resolveImage = this.options.resolveImage
    return ({ node: initial }) => {
      const dom = document.createElement('div')
      dom.className = 'image-block'
      let node = initial
      let resolved: ResolvedImage | null = null
      let generation = 0
      let destroyed = false

      const release = () => {
        if (!resolved) return
        const done = resolved
        resolved = null
        done.revoke()
      }
      const show = (child: HTMLElement) => dom.replaceChildren(child)
      const showImage = (url: string) => {
        const img = document.createElement('img')
        img.alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
        if (node.attrs.title) img.title = String(node.attrs.title)
        img.draggable = false
        img.addEventListener('error', () => {
          if (dom.contains(img)) show(placeholder(node, REASON_FAILED))
        }, { once: true })
        img.src = url
        show(img)
      }

      const render = () => {
        const mine = ++generation
        release()
        const src = typeof node.attrs.src === 'string' ? node.attrs.src.trim() : ''
        dom.removeAttribute('data-image-state')
        let cls = classifyImageSrc(src)
        if (cls.kind === 'direct' && src.startsWith('data:') && src.length > MAX_DATA_IMAGE_SRC_LENGTH) {
          cls = { kind: 'blocked', reason: 'unsupported' }
        }
        if (cls.kind === 'direct') {
          dom.setAttribute('data-image-state', 'shown')
          showImage(src)
          return
        }
        if (cls.kind === 'blocked') {
          const state = cls.reason === 'web' ? 'blocked-web' : cls.reason === 'not-imported' ? 'not-imported' : 'unsupported'
          const reason = cls.reason === 'web' ? REASON_WEB : cls.reason === 'not-imported' ? REASON_NOT_IMPORTED : REASON_UNSUPPORTED
          dom.setAttribute('data-image-state', state)
          show(placeholder(node, reason))
          return
        }
        if (!resolveImage) {
          dom.setAttribute('data-image-state', 'unresolved')
          show(placeholder(node, REASON_NO_RESOLVER))
          return
        }
        dom.setAttribute('data-image-state', 'loading')
        show(placeholder(node, 'Loading…'))
        resolveImage(src).then(
          result => {
            if (destroyed || mine !== generation) {
              result?.revoke()
              return
            }
            if (!result) {
              dom.setAttribute('data-image-state', 'failed')
              show(placeholder(node, REASON_FAILED))
              return
            }
            resolved = result
            dom.setAttribute('data-image-state', 'shown')
            showImage(result.url)
          },
          (error: unknown) => {
            if (destroyed || mine !== generation) return
            const reason = error instanceof Error && error.message ? error.message : REASON_FAILED
            dom.setAttribute('data-image-state', 'failed')
            show(placeholder(node, reason))
          },
        )
      }

      syncWrapperAttrs(dom, node)
      render()

      return {
        dom,
        update(next: ProseMirrorNode) {
          if (next.type !== node.type) return false
          const prev = node
          node = next
          syncWrapperAttrs(dom, node)
          if (prev.attrs.src !== next.attrs.src || prev.attrs.alt !== next.attrs.alt || prev.attrs.title !== next.attrs.title) {
            render()
          }
          return true
        },
        ignoreMutation: () => true,
        destroy() {
          destroyed = true
          generation++
          release()
        },
      }
    }
  },

  addCommands() {
    return {
      insertImage:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          })
        },
    }
  },
})

export default ImageBlock
