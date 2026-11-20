/**
 * markdown-paste.ts — pasted Markdown becomes blocks.
 *
 * Pasting text from an agent, a README or another Markdown app left the
 * Markdown literal: "## Title" and "- item" as plain text (friction triage,
 * 2026-11-16; agent output is Markdown). Now, when the clipboard holds plain
 * text that reads as Markdown and no HTML, it is converted to HTML and handed
 * to ProseMirror's own paste pipeline (view.pasteHTML), so the outliner's paste
 * rules shape it exactly as they shape any rich paste.
 *
 * Plain paste stays available: Command-Shift-V (Paste and Match Style) and any
 * paste inside a code block insert the text as is. Rich HTML from other apps
 * keeps today's behaviour, minus fonts and colours, which made pasted text look
 * foreign; a copy from inside the editor keeps its own styles.
 *
 * The converter is deliberately small (no dependency): ATX headings, bullet,
 * ordered and task lists with nesting by indent, block quotes, fenced code,
 * horizontal rules, paragraphs, and inline bold, italic, strike, code and links.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

export const markdownPasteKey = new PluginKey('markdownPaste')

const BLOCK_SIGNS = [
  /^#{1,6}\s+\S/,
  /^\s*[-*+]\s+\S/,
  /^\s*\d+[.)]\s+\S/,
  /^\s*[-*+]\s+\[[ xX]\]\s/,
  /^>\s?/,
  /^```/,
  /^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/,
]
const INLINE_SIGNS = [/\*\*[^*\n]+\*\*/, /\[[^\]\n]+\]\((https?:|mailto:)[^)\s]+\)/, /`[^`\n]+`/]

/** Whether plain text reads as Markdown worth converting. */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.some(line => BLOCK_SIGNS.some(sign => sign.test(line)))) return true
  return INLINE_SIGNS.filter(sign => sign.test(text)).length >= 1 && text.includes('\n')
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const SAFE_HREF = /^(https?:|mailto:)/i

/** Inline Markdown to HTML: code first (literal), then links, bold, italic, strike. */
export function inlineMarkdownToHtml(text: string): string {
  const codes: string[] = []
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = escapeHtml(out)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) =>
    SAFE_HREF.test(href) ? `<a href="${href}">${label}</a>` : match)
  out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<strong>${a ?? b}</strong>`)
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)|(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g,
    (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) => `${p1 ?? p2 ?? ''}<em>${a ?? b}</em>`)
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '')
}

function indentOf(line: string): number {
  const spaces = line.match(/^[ \t]*/)?.[0] ?? ''
  const width = [...spaces].reduce((sum, ch) => sum + (ch === '\t' ? 4 : 1), 0)
  return Math.floor(width / 2)
}

/** Block Markdown to HTML in the shapes the editor's paste rules read. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inlineMarkdownToHtml).join('<br>')}</p>`)
    paragraph = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const fence = line.match(/^```\s*([\w+-]*)\s*$/)
    if (fence) {
      flush()
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : ''
      html.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flush()
      const level = Math.min(heading[1]!.length, 3)
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2]!.replace(/\s+#+\s*$/, ''))}</h${level}>`)
      continue
    }
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line.trim())) { flush(); html.push('<hr>'); continue }
    const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/)
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
    const ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/)
    if (task || bullet || ordered) {
      flush()
      const indent = indentOf(line)
      const indentAttr = indent > 0 ? ` data-indent="${indent}"` : ''
      if (task) {
        const checked = task[2] !== ' ' ? ' data-checked="true"' : ''
        html.push(`<ul><li data-list-type="task"${indentAttr}${checked}><p>${inlineMarkdownToHtml(task[3]!)}</p></li></ul>`)
      } else if (bullet) {
        html.push(`<ul><li data-list-type="bullet"${indentAttr}><p>${inlineMarkdownToHtml(bullet[2]!)}</p></li></ul>`)
      } else if (ordered) {
        html.push(`<ol><li data-list-type="ordered"${indentAttr}><p>${inlineMarkdownToHtml(ordered[2]!)}</p></li></ol>`)
      }
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flush()
      const body = [quote[1]!]
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]!)) body.push(lines[++i]!.replace(/^>\s?/, ''))
      html.push(`<blockquote><p>${body.map(inlineMarkdownToHtml).join('<br>')}</p></blockquote>`)
      continue
    }
    paragraph.push(line)
  }
  flush()
  return html.join('')
}

/**
 * Fonts and colours from other apps' HTML, removed. A copy from inside the
 * editor (data-pm-slice) keeps its styles: those were chosen here.
 */
export function stripForeignStyles(html: string): string {
  if (html.includes('data-pm-slice')) return html
  return html
    .replace(/<\/?font\b[^>]*>/gi, '')
    .replace(/\s(style|color|face|bgcolor)="[^"]*"/gi, '')
    .replace(/\s(style|color|face|bgcolor)='[^']*'/gi, '')
}

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',

  addProseMirrorPlugins() {
    // Command-Shift-V asks for the text as is; the flag rides to the paste it starts.
    let plainNext = false
    // view.pasteHTML / pasteText run the paste props again with the same event.
    let reentered = false
    const pasteAs = (run: () => void): true => {
      reentered = true
      try { run() } finally { reentered = false }
      return true
    }
    return [
      new Plugin({
        key: markdownPasteKey,
        props: {
          handleKeyDown: (_view, event) => {
            if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'v' || event.key === 'V')) plainNext = true
            return false
          },
          transformPastedHTML: (html) => stripForeignStyles(html),
          handlePaste: (view, event) => {
            if (reentered) return false
            const plain = plainNext
            plainNext = false
            const data = event.clipboardData
            if (!data) return false
            if (plain) {
              const text = data.getData('text/plain')
              if (!text) return false
              return pasteAs(() => view.pasteText(text, event))
            }
            if (data.getData('text/html')) return false
            if (view.state.selection.$from.parent.type.spec.code) return false
            const text = data.getData('text/plain')
            if (!text || !looksLikeMarkdown(text)) return false
            return pasteAs(() => view.pasteHTML(markdownToHtml(text), event))
          },
        },
      }),
    ]
  },
})
