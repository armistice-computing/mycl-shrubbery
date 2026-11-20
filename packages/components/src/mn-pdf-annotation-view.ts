import { LitElement, css, html, nothing, unsafeCSS, type TemplateResult } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { SkinAware } from './skin-aware.js'
import { icon, iconStyles } from './icons.js'
import './mn-empty-state.js'
import type { MnPdfAnnotation, MnPdfAnnotationSelectDetail } from './mn-pdf-reader.js'

export interface MnPdfAnnotationOpenOriginalDetail extends MnPdfAnnotationSelectDetail {}

interface AnnotationPageGroup {
  readonly pageNumber: number
  readonly annotations: readonly MnPdfAnnotation[]
}

function pageGroups(annotations: readonly MnPdfAnnotation[]): readonly AnnotationPageGroup[] {
  const pages = new Map<number, MnPdfAnnotation[]>()
  for (const annotation of annotations) {
    const page = annotation.pageNumber
    pages.set(page, [...(pages.get(page) ?? []), annotation])
  }
  return Array.from(pages.entries())
    .sort(([a], [b]) => a - b)
    .map(([pageNumber, grouped]) => ({ pageNumber, annotations: grouped }))
}

@customElement('mn-pdf-annotation-view')
export class MnPdfAnnotationView extends SkinAware(LitElement) {
  static styles = css`
    ${unsafeCSS(iconStyles)}

    :host {
      display: flex;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      color: var(--mn-color-text-primary, #111827);
      background: var(--mn-color-surface-base, #fff);
      font-family: var(--mn-font-chrome, system-ui, sans-serif);
      font-size: var(--mn-text-sm, 13px);
    }

    .annotation-scroll {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      overflow: auto;
      background: var(--mn-color-surface-sunken, #f8fafc);
    }

    .annotation-content {
      width: min(860px, 100%);
      margin: 0 auto;
      padding: var(--mn-space-5, 20px) var(--mn-space-4, 16px) var(--mn-space-8, 32px);
      box-sizing: border-box;
    }

    .page-group + .page-group {
      margin-top: var(--mn-space-6, 24px);
    }

    .page-heading {
      display: flex;
      align-items: baseline;
      gap: var(--mn-space-2, 8px);
      margin-bottom: var(--mn-space-2, 8px);
      color: var(--mn-color-text-secondary, #374151);
      font-size: var(--mn-text-xs, 12px);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .page-count {
      color: var(--mn-color-text-tertiary, #6b7280);
      font-weight: 500;
      text-transform: none;
    }

    .annotation-item {
      display: grid;
      width: 100%;
      min-width: 0;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--mn-space-3, 12px);
      padding: var(--mn-space-3, 12px);
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-card, 8px);
      background: var(--mn-color-surface-raised, #fff);
      box-sizing: border-box;
    }

    .annotation-item + .annotation-item {
      margin-top: var(--mn-space-2, 8px);
    }

    .annotation-main {
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }

    .annotation-item[data-active='true'] {
      border-color: var(--mn-color-border-accent, #93c5fd);
      background: var(--mn-color-surface-accent, #eff6ff);
    }

    .annotation-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--mn-space-2, 8px);
      margin-bottom: 4px;
      color: var(--mn-color-text-tertiary, #6b7280);
      font-size: var(--mn-text-xs, 12px);
    }

    .annotation-kind {
      font-weight: 700;
    }

    .annotation-source {
      color: var(--mn-color-text-secondary, #4b5563);
    }

    .annotation-label {
      margin-left: auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .annotation-quote {
      color: var(--mn-color-text-primary, #111827);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .annotation-note {
      display: block;
      margin-top: var(--mn-space-2, 8px);
      padding-left: var(--mn-space-2, 8px);
      border-left: 2px solid var(--mn-color-border-accent, #93c5fd);
      color: var(--mn-color-text-secondary, #4b5563);
      font-size: var(--mn-text-xs, 12px);
      line-height: 1.45;
      white-space: pre-wrap;
    }

    .annotation-open {
      display: inline-flex;
      align-self: center;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      background: var(--mn-color-surface-base, #fff);
      color: var(--mn-color-text-secondary, #374151);
      cursor: pointer;
    }

    .annotation-open:hover {
      color: var(--mn-color-text-primary, #111827);
      background: var(--mn-color-surface-hover, #f3f4f6);
    }

    .state {
      display: grid;
      min-height: 220px;
      align-content: center;
    }
  `

  @property({ attribute: false }) annotations: readonly MnPdfAnnotation[] = []
  @property({ type: String }) activeAnnotationId = ''

  private _emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }))
  }

  private _select(annotation: MnPdfAnnotation): void {
    this._emit<MnPdfAnnotationSelectDetail>('mn-pdf-annotation-select', {
      annotationId: annotation.id,
      annotation,
    })
  }

  private _openOriginal(annotation: MnPdfAnnotation): void {
    this._emit<MnPdfAnnotationOpenOriginalDetail>('mn-pdf-annotation-open-original', {
      annotationId: annotation.id,
      annotation,
    })
  }

  private _renderAnnotation(annotation: MnPdfAnnotation): TemplateResult {
    const active = annotation.id === this.activeAnnotationId
    const source = annotation.source === 'embedded' ? 'Imported' : 'Mycl'
    const kind = annotation.kind === 'note' ? 'Note' : 'Highlight'
    const notes = annotation.note?.split(/\n{2,}/) ?? []
    return html`
      <div class="annotation-item" role="listitem" data-active=${active ? 'true' : 'false'}>
        <button
          type="button"
          class="annotation-main"
          aria-label=${`Select annotation: ${annotation.quote || `page ${annotation.pageNumber}`}`}
          @click=${() => this._select(annotation)}
        >
          <span class="annotation-meta">
            <span class="annotation-kind">${kind}</span>
            <span class="annotation-source">${source}</span>
            ${annotation.label?.trim() ? html`<span class="annotation-label">${annotation.label}</span>` : nothing}
          </span>
          <span class="annotation-quote">${annotation.quote || 'No text recovered'}</span>
          ${notes.map(note => html`<span class="annotation-note">${note}</span>`)}
        </button>
        <button
          type="button"
          class="annotation-open"
          aria-label=${`Open original at page ${annotation.pageNumber}`}
          @click=${(event: MouseEvent) => {
            event.stopPropagation()
            this._openOriginal(annotation)
          }}
        >
          ${icon('external-link', { size: 13 })}
        </button>
      </div>
    `
  }

  render(): TemplateResult {
    if (this.annotations.length === 0) {
      return html`
        <div class="annotation-scroll">
          <div class="state">
            <mn-empty-state
              icon="highlighter"
              title="No annotations yet"
              description="Select text in Original to highlight or annotate it."
              variant="compact"
            ></mn-empty-state>
          </div>
        </div>
      `
    }
    return html`
      <div class="annotation-scroll">
        <div class="annotation-content" role="list" aria-label="PDF annotations">
          ${repeat(pageGroups(this.annotations), group => group.pageNumber, group => html`
            <section class="page-group" aria-label=${`Page ${group.pageNumber}`}>
              <div class="page-heading">
                <span>Page ${group.pageNumber} · ${group.annotations.length} annotation${group.annotations.length === 1 ? '' : 's'}</span>
              </div>
              ${repeat(group.annotations, annotation => annotation.id, annotation => this._renderAnnotation(annotation))}
            </section>
          `)}
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-pdf-annotation-view': MnPdfAnnotationView
  }
}
