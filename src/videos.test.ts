import { expect, describe, test } from 'vitest'

import { shouldSendEmail } from './videos'
import { ChannelEntry } from './config'

describe('shouldSendEmail', () => {
	const on = { notifyOnFirstScan: true }
	const off = { notifyOnFirstScan: false }

	test('no entry, not first scan, global on → send', () => {
		expect(shouldSendEmail(on, undefined, false)).toBe(true)
	})
	test('no entry, first scan, global on → send', () => {
		expect(shouldSendEmail(on, undefined, true)).toBe(true)
	})
	test('no entry, first scan, global off → skip', () => {
		expect(shouldSendEmail(off, undefined, true)).toBe(false)
	})
	test('muted, not first scan → skip', () => {
		const e: ChannelEntry = { id: 'A', notify: false }
		expect(shouldSendEmail(on, e, false)).toBe(false)
	})
	test('muted, first scan → skip', () => {
		const e: ChannelEntry = { id: 'A', notify: false }
		expect(shouldSendEmail(on, e, true)).toBe(false)
	})
	test('per-channel notifyOnFirstScan false overrides global on', () => {
		const e: ChannelEntry = { id: 'A', notifyOnFirstScan: false }
		expect(shouldSendEmail(on, e, true)).toBe(false)
	})
	test('per-channel notifyOnFirstScan true overrides global off', () => {
		const e: ChannelEntry = { id: 'A', notifyOnFirstScan: true }
		expect(shouldSendEmail(off, e, true)).toBe(true)
	})
	test('per-channel notifyOnFirstScan false, not first scan → send', () => {
		const e: ChannelEntry = { id: 'A', notifyOnFirstScan: false }
		expect(shouldSendEmail(on, e, false)).toBe(true)
	})
})
