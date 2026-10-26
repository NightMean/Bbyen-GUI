import { describe, expect, test } from 'vitest'
import { chooseInitialVideos, parseBacklogPolicy } from './initialBacklog'

describe('initial backlog selection', () => {
	const items = [
		{ videoId: 'old', isoDate: '2026-01-01T00:00:00Z' },
		{ videoId: 'b', isoDate: '2026-01-02T00:00:00Z' },
		{ videoId: 'a', isoDate: '2026-01-02T00:00:00Z' },
		{ videoId: 'missing' },
	]
	test('uses deterministic tie and missing-date ordering', () => {
		const result = chooseInitialVideos(items, { mode: 'newest', count: 2 })
		expect([...result]).toEqual(['a', 'b'])
	})
	test('excludes already processed videos before ranking', () => {
		const result = chooseInitialVideos(items.filter(i => i.videoId !== 'a'),
			{ mode: 'newest', count: 2 })
		expect([...result]).toEqual(['b', 'old'])
	})
	test('validates count and policy without coercion', () => {
		for (const value of [null, {}, { mode: 'newest', count: 0 },
			{ mode: 'newest', count: 1.5 }, { mode: 'all', count: 3 },
			{ mode: 'newest', count: '2' }]) {
			expect(() => parseBacklogPolicy(value, 'backlog')).toThrow()
		}
	})
})
