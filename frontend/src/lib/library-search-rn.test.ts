import { describe, expect, it } from 'vitest'
import { createLibrarySearch } from '../../../mobile-rn/src/librarySearch'
import type { SuggestionIndexFactory } from '../../../mobile-rn/src/librarySearch'
import type { Profile } from '../../../mobile-rn/src/training'

const baseProfile: Profile = { unit: 'kg', favEx: [] }

// Stand-in for Fuse in this cross-client test: CI installs frontend deps only,
// and the real index is exercised by mobile-rn/scripts/fuse-suggestion-check.mjs.
const familyIndex: SuggestionIndexFactory = pool => ({
  search: (query, limit) => pool
    .filter(item => item.name.includes('高位下拉') || item.name.includes('高位下啦'))
    .slice(0, limit),
})

const filters = {
  bodyPart: null,
  equipment: null,
  targetMuscle: null,
  oneLimb: false,
  favouritesOnly: false,
}

describe('RN library search adapter', () => {
  it('searches built-in Chinese and English names through the shared engine', () => {
    const search = createLibrarySearch(baseProfile)
    expect(search.search('绳索单臂高位下拉', filters).items.map(item => item.id)).toContain('1204')
    expect(search.search('cable one arm lat pulldown', filters).items.map(item => item.id)).toContain('1204')
  })

  it('reads profile aliases and custom exercise aliases', () => {
    const profile: Profile = {
      ...baseProfile,
      exAliases: { '1204': ['我的高位下拉'] },
      customEx: [{ id: 'custom-1', n: '自建划船', bp: 'back', eq: 'cable', aliases: ['Viking row'] }],
    }
    const search = createLibrarySearch(profile)
    expect(search.search('我的高位下拉', filters).items.map(item => item.id)).toEqual(['1204'])
    const custom = search.search('Viking row', filters).items
    expect(custom).toHaveLength(1)
    expect(custom[0].id).toBe('custom-1')

    // Another workspace has no such alias: the same query finds nothing.
    const other = createLibrarySearch({ ...baseProfile, customEx: profile.customEx })
    expect(other.search('我的高位下拉', filters).items).toEqual([])
  })

  it('intersects body part, equipment, target muscle, one-limb and favourites', () => {
    const search = createLibrarySearch(baseProfile)
    const combined = search.search('', {
      bodyPart: 'back',
      equipment: 'cable',
      targetMuscle: 'lats',
      oneLimb: true,
      favouritesOnly: false,
    })
    expect(combined.items.map(item => item.id)).toContain('1204')
    expect(combined.items.every(item => item.bp === 'back' && item.eq === 'cable' && item.tg === 'lats')).toBe(true)
    // Two-arm cable pulldown, band one-arm row and another target muscle are all out.
    expect(combined.items.map(item => item.id)).not.toContain('0198')
    expect(combined.items.map(item => item.id)).not.toContain('0988')
    expect(combined.items.map(item => item.id)).not.toContain('0025')

    const favourites = createLibrarySearch({ ...baseProfile, favEx: ['1204'] }).search('', {
      bodyPart: 'back',
      equipment: 'cable',
      targetMuscle: 'lats',
      oneLimb: true,
      favouritesOnly: true,
    })
    expect(favourites.items.map(item => item.id)).toEqual(['1204'])
  })

  it('keeps the total over the whole result set while the page grows', () => {
    const search = createLibrarySearch(baseProfile)
    const first = search.search('a', filters, 10)
    expect(first.items).toHaveLength(10)
    expect(first.total).toBeGreaterThan(10)
    const second = search.search('a', filters, 20)
    expect(second.items).toHaveLength(20)
    expect(second.total).toBe(first.total)
    expect(second.items.slice(0, 10).map(item => item.id)).toEqual(first.items.map(item => item.id))
  })

  it('keeps custom exercises and favourites first for an empty query', () => {
    const profile: Profile = {
      ...baseProfile,
      favEx: ['1204'],
      customEx: [{ id: 'custom-1', n: '自建划船', bp: 'back', eq: 'cable' }],
    }
    const items = createLibrarySearch(profile).search('', filters).items
    expect(items[0].id).toBe('1204')
    expect(items[1].id).toBe('custom-1')
  })

  it('keeps filters when they produce no results and returns suggestions from the same pool', () => {
    const search = createLibrarySearch(baseProfile, familyIndex)
    const all = search.search('高位下啦', filters)
    expect(all.total).toBe(0)
    expect(all.suggestions.length).toBeGreaterThan(0)
    expect(all.suggestions.length).toBeLessThanOrEqual(3)

    const narrowed = search.search('高位下啦', { ...filters, equipment: 'cable' })
    expect(narrowed.total).toBe(0)
    expect(narrowed.suggestions).toHaveLength(3)
    expect(narrowed.suggestions.every(item => item.eq === 'cable')).toBe(true)
    expect(narrowed.suggestions.every(item => item.name.includes('高位下拉'))).toBe(true)
  })

  it('does not suggest on empty, short or normal queries', () => {
    const search = createLibrarySearch(baseProfile, familyIndex)
    expect(search.search('', filters).suggestions).toEqual([])
    expect(search.search('卧堆', filters).suggestions).toEqual([])
    expect(search.search('高位下拉', filters).suggestions).toEqual([])
  })
})
