import { describe, expect, it } from 'vitest'
import { EXDB } from './exercises-data.js'
import zh from '../exercise-names/zh.js'
import SEARCH_META from './exercise-search-meta.json' with { type: 'json' }
import {
  BANNED_BROAD_ALIASES,
  POSTURE_SLUGS,
  VARIANT_CHECKS,
  normalizeMetaText,
} from '../../../scripts/generate-exercise-search-meta.mjs'

const BY_ID = new Map(EXDB.map(entry => [String(entry.id), entry]))
const POSTURE_SET = new Set(POSTURE_SLUGS)

describe('exercise-search-meta catalogue integrity and collision guards', () => {
  it('keeps version, posture enum, and valid EXDB references', () => {
    expect(SEARCH_META.version).toBe(1)
    expect(SEARCH_META.postures).toEqual(POSTURE_SLUGS)
    expect(POSTURE_SLUGS).toHaveLength(8)

    const entries = Object.entries(SEARCH_META.byId || {})
    expect(entries.length).toBeGreaterThan(2000)

    for (const [id, record] of entries) {
      expect(BY_ID.has(id), `Unknown id ${id}`).toBe(true)
      expect(record && typeof record === 'object' && !Array.isArray(record)).toBe(true)
      if (record.p !== undefined) {
        expect(POSTURE_SET.has(record.p), `Invalid posture "${record.p}" on ${id}`).toBe(true)
      }
      if (record.a !== undefined) {
        expect(Array.isArray(record.a)).toBe(true)
        expect(record.a.length).toBeGreaterThan(0)
      }
    }
  })

  it('guarantees zero exact-alias collisions across distinct exercise ids', () => {
    const owner = new Map()
    for (const [id, record] of Object.entries(SEARCH_META.byId || {})) {
      for (const alias of record.a || []) {
        const norm = normalizeMetaText(alias)
        expect(norm.length).toBeGreaterThan(0)
        const existing = owner.get(norm)
        expect(existing && existing !== id, `Alias "${alias}" collides: ${existing} vs ${id}`).toBeFalsy()
        owner.set(norm, id)
      }
    }
  })

  it('blocks overly broad ambiguous terms and cross-variant misassignments', () => {
    for (const [id, record] of Object.entries(SEARCH_META.byId || {})) {
      const ex = BY_ID.get(id)
      const targetBlob = normalizeMetaText(`${ex?.n || ''} ${zh?.[id] || ''}`)
      for (const alias of record.a || []) {
        const norm = normalizeMetaText(alias)
        expect(BANNED_BROAD_ALIASES.has(norm), `Banned broad alias "${alias}" on ${id}`).toBe(false)
        for (const rule of VARIANT_CHECKS) {
          if (rule.aliasRe.test(norm)) {
            expect(rule.targetRe.test(targetBlob), `Variant "${rule.key}" mismatch on ${id}: "${alias}"`).toBe(true)
          }
        }
      }
    }
  })

  it('labels postures and curated aliases accurately on core commercial machines', () => {
    expect(SEARCH_META.byId['1041']?.p).toBe('supine')
    expect(SEARCH_META.byId['1041']?.a).toContain('lever lying chest press')
    expect(SEARCH_META.byId['1041']?.a).toContain('杠杆仰卧卧推')
    expect(SEARCH_META.byId['0576']?.p).toBe('seated')
    expect(SEARCH_META.byId['10671']?.p).toBe('seated')
    expect(SEARCH_META.byId['0603']?.p).toBe('seated')
    expect(SEARCH_META.byId['1454']?.p).toBe('seated')
    expect(SEARCH_META.byId['1030']?.p).toBe('seated')
    expect(SEARCH_META.byId['1030']?.a).toContain('lever pec fly')
    expect(SEARCH_META.byId['0150']?.p).toBe('seated')
    expect(SEARCH_META.byId['0150']?.a).toContain('cable bar lat pulldown')
    expect(SEARCH_META.byId['0585']?.p).toBe('seated')
    expect(SEARCH_META.byId['0586']?.p).toBe('prone')
    expect(SEARCH_META.byId['0599']?.p).toBe('seated')
    expect(SEARCH_META.byId['0739']?.p).toBe('supine')
  })
})
