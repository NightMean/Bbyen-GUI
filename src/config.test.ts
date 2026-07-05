import { vi, expect, describe, test } from 'vitest'
import winston from 'winston'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'

import  {
	normalizeChannelFactory,
	normalizeChannelEntries,
	buildChannelSettingsMap,
} from './config'

function createMagicStub<T extends object>(): T {
	return new Proxy({} as T, {
		get: (target: T, prop: string) => {
			if (!(prop in target)) {
				// If the method does not exist, create it as a mock function
				(target as any)[prop] = vi.fn()
			}
			return target[prop as keyof T]
		}
	})
}

describe('normalizeChannel', async () => {
	const logger = createMagicStub<winston.Logger>()
	const service = createMagicStub<youtube_v3.Youtube>()
	const auth = createMagicStub<OAuth2Client>()

	const normalizeChannel = normalizeChannelFactory(logger, service, auth)

	test('already a channel id', async () => {
		expect(await normalizeChannel('UCzgA9CBrIXPtkB2yNTTiy1w'))
			.toBe('UCzgA9CBrIXPtkB2yNTTiy1w')
	})
	// /c/ and /channel/ always seem to give 404 now
	test('already a channel id', async () => {
		expect(await normalizeChannel('https://www.youtube.com/@Level2Jeff'))
			.toBe('UCzgA9CBrIXPtkB2yNTTiy1w')
	})
})

describe('normalizeChannelEntries', () => {
	// Stub normalizeChannel: pretend the handle maps to a known id,
	// everything else passes through unchanged.
	const normalize = async (c: string) =>
		c === 'https://www.youtube.com/@X' ? 'UCX' : c

	test('plain string becomes { id }', async () => {
		const out = await normalizeChannelEntries(normalize, ['UCabc'])
		expect(out).toEqual([{ id: 'UCabc' }])
	})
	test('object preserves flags, normalizes id', async () => {
		const out = await normalizeChannelEntries(normalize, [
			{ id: 'https://www.youtube.com/@X', notify: false },
		])
		expect(out).toEqual([{ id: 'UCX', notify: false }])
	})
	test('undefined passes through', async () => {
		expect(await normalizeChannelEntries(normalize, undefined))
			.toBeUndefined()
	})
})

describe('buildChannelSettingsMap', () => {
	test('only entries with flags are included', () => {
		const map = buildChannelSettingsMap([
			{ id: 'A' },
			{ id: 'B', notify: false },
			{ id: 'C', notifyOnFirstScan: false },
		])
		expect(map.has('A')).toBe(false)
		expect(map.get('B')).toEqual({ id: 'B', notify: false })
		expect(map.get('C')).toEqual({ id: 'C', notifyOnFirstScan: false })
	})
	test('undefined yields empty map', () => {
		expect(buildChannelSettingsMap(undefined).size).toBe(0)
	})
})
