import { expect, describe, test } from 'vitest'

import { isChannelId, assertChannelId } from './channelId'

describe('isChannelId', () => {
	test('accepts a 24-char UC id', () => {
		expect(isChannelId('UCcUNYFu8wNDncymesUOtPrg')).toBe(true)
	})
	test('rejects a handle', () => {
		expect(isChannelId('@SomeChannel')).toBe(false)
	})
	test('rejects a URL', () => {
		expect(isChannelId('https://www.youtube.com/@SomeChannel')).toBe(false)
	})
	test('rejects a too-short string', () => {
		expect(isChannelId('UC123')).toBe(false)
	})
})

describe('assertChannelId', () => {
	test('returns the id when valid', () => {
		expect(assertChannelId('UCcUNYFu8wNDncymesUOtPrg'))
			.toBe('UCcUNYFu8wNDncymesUOtPrg')
	})
	test('throws with a clear message when invalid', () => {
		expect(() => assertChannelId('@x')).toThrowError(/raw channel ID/)
	})
})
