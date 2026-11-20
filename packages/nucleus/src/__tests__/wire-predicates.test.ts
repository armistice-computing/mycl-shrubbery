import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WIRE_PREDICATE_NAME,
  DEFAULT_WIRE_PREDICATE_URI,
  MNEMO_NS,
  PREDICATE_GROUPS,
  getAllWirePredicates,
  getWireFamily,
  getWirePredicateCategory,
  getWirePredicateLabel,
  normalizeWirePredicateUri,
} from '../wire-predicates.js'

describe('wire families', () => {
  it('sorts predicates into judgment, record and dream as gardend does', () => {
    expect(getWireFamily('supports')).toBe('judgment')
    expect(getWireFamily('http://mnemosyne.ai/vocab#relatedTo')).toBe('judgment')
    expect(getWireFamily('cites')).toBe('record')
    expect(getWireFamily('http://mnemosyne.ai/vocab#recalls')).toBe('record')
    expect(getWireFamily('authoredBy')).toBe('record')
    expect(getWireFamily('dreamtOf')).toBe('dream')
    expect(getWirePredicateLabel('dreamtOf')).toBe('dreamt of')
    expect(getWirePredicateLabel('authoredBy')).toBe('is authored by')
    // Neither family is offered for a person to choose.
    expect(getAllWirePredicates().some(p => /dreamtOf|cites|recalls|authoredBy/.test(p.uri))).toBe(false)
  })
})

describe('wire predicate taxonomy', () => {
  it('keeps the Garden predicate groups and default relation label in one pure module', () => {
    expect(Object.keys(PREDICATE_GROUPS)).toEqual(['Ground', 'Critique', 'Genesis', 'Structure'])
    expect(getAllWirePredicates().map((p) => p.uri)).toContain(`${MNEMO_NS}supports`)
    expect(getWirePredicateLabel(DEFAULT_WIRE_PREDICATE_URI)).toBe('is related to')
    expect(getWirePredicateLabel(DEFAULT_WIRE_PREDICATE_NAME)).toBe('is related to')
  })

  it('normalizes bare names, known URIs, legacy URIs, and unknown camel-case predicates', () => {
    expect(normalizeWirePredicateUri('supports')).toBe(`${MNEMO_NS}supports`)
    expect(getWirePredicateCategory(`${MNEMO_NS}supports`)).toBe('Critique')
    expect(getWirePredicateLabel(`${MNEMO_NS}partOf`)).toBe('is part of')
    expect(getWirePredicateLabel(`${MNEMO_NS}newPredicateKind`)).toBe('new predicate kind')
  })
})
