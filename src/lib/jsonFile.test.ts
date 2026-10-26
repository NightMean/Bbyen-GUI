import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { updateJsonFile } from './jsonFile'
import { mergeChannelEntries, parseChannelLists } from './channelConfig'

let directory: string
let filename: string
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-json-test-'))
	filename = path.join(directory, 'channels.json')
})
afterEach(async () => {
	vi.restoreAllMocks()
	for (const name of await fs.readdir(directory)) {
		await fs.unlink(path.join(directory, name))
	}
	await fs.rmdir(directory)
})

test('deduplicates objects and strings while preserving explicit flags', () => {
	expect(mergeChannelEntries(['A', { id: 'A', notify: false }, 'A']))
		.toEqual([{ id: 'A', notify: false }])
})

test.each([null, [], { whitelistedChannelIds: 'A' }, {
	whitelistedChannelIds: [{ id: 'A', notify: 'false' }],
}])('rejects invalid channel structures', value => {
	expect(() => parseChannelLists(value)).toThrow()
})

test('preserves malformed input and releases the lock', async () => {
	await fs.writeFile(filename, '{broken json')
	await expect(updateJsonFile(filename, () => ({})))
		.rejects.toThrow('Invalid JSON')
	expect(await fs.readFile(filename, 'utf8')).toBe('{broken json')
	expect(await fs.readdir(directory)).toEqual(['channels.json'])
})

test('requires an existing file unless creation is explicitly enabled',
	async () => {
		await expect(updateJsonFile(filename, () => ({ unrestricted: true })))
			.rejects.toMatchObject({ code: 'ENOENT' })
		expect(await fs.readdir(directory)).toEqual([])
	})

test('preserves original content if replacement fails', async () => {
	await fs.writeFile(filename, '{"existing":true}')
	vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk failure'))
	await expect(updateJsonFile(filename, () => ({ changed: true })))
		.rejects.toThrow('Disk failure')
	expect(await fs.readFile(filename, 'utf8')).toBe('{"existing":true}')
	expect(await fs.readdir(directory)).toEqual(['channels.json'])
})

test('refuses a competing writer without losing the first update', async () => {
	let release!: () => void
	const pending = new Promise<void>(resolve => { release = resolve })
	let started!: () => void
	const ready = new Promise<void>(resolve => { started = resolve })
	const first = updateJsonFile(filename, async () => {
		started()
		await pending
		return { first: true }
	}, { createIfMissing: true })
	await ready
	await expect(updateJsonFile(filename, () => ({ second: true })))
		.rejects.toThrow('locked')
	release()
	await first
	expect(JSON.parse(await fs.readFile(filename, 'utf8')))
		.toEqual({ first: true })
})
