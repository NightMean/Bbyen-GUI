import { describe, test, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import {
	extractChannelIdFromHtml,
	toLookupUrl,
	resolveChannelId,
} from './resolveChannelId'

vi.mock('axios')

describe('extractChannelIdFromHtml', () => {
	test('extracts from RSS feed link tag', () => {
		const html = `
			<html>
			<head>
				<link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA">
			</head>
			</html>
		`
		expect(extractChannelIdFromHtml(html)).toBe('UCHnyfMqiRRG1u-2MsSQLbXA')
	})

	test('extracts from meta itemprop identifier', () => {
		const html = `
			<html>
			<head>
				<meta itemprop="identifier" content="UCBJycsmduvYEL83R_U4JriQ">
			</head>
			</html>
		`
		expect(extractChannelIdFromHtml(html)).toBe('UCBJycsmduvYEL83R_U4JriQ')
	})

	test('extracts from meta itemprop channelId', () => {
		const html = `
			<html>
			<head>
				<meta itemprop="channelId" content="UCBJycsmduvYEL83R_U4JriQ">
			</head>
			</html>
		`
		expect(extractChannelIdFromHtml(html)).toBe('UCBJycsmduvYEL83R_U4JriQ')
	})

	test('extracts from link rel canonical', () => {
		const html = `
			<html>
			<head>
				<link rel="canonical" href="https://www.youtube.com/channel/UCzgA9CBrIXPtkB2yNTTiy1w">
			</head>
			</html>
		`
		expect(extractChannelIdFromHtml(html)).toBe('UCzgA9CBrIXPtkB2yNTTiy1w')
	})

	test('extracts from embedded JSON channelId', () => {
		const html = `
			<script>
				var ytInitialData = {"channelId":"UCcUNYFu8wNDncymesUOtPrg"};
			</script>
		`
		expect(extractChannelIdFromHtml(html)).toBe('UCcUNYFu8wNDncymesUOtPrg')
	})

	test('extracts from embedded JSON externalId', () => {
		const html = `
			<script>
				var ytInitialData = {"externalId":"UCcUNYFu8wNDncymesUOtPrg"};
			</script>
		`
		expect(extractChannelIdFromHtml(html)).toBe('UCcUNYFu8wNDncymesUOtPrg')
	})

	test('returns null if no channel ID is found in HTML', () => {
		const html = '<html><body><h1>Not found</h1></body></html>'
		expect(extractChannelIdFromHtml(html)).toBeNull()
	})
})

describe('toLookupUrl', () => {
	test('formats @handle as youtube URL', () => {
		expect(toLookupUrl('@veritasium')).toBe('https://www.youtube.com/@veritasium')
	})

	test('formats bare name as @handle URL', () => {
		expect(toLookupUrl('veritasium')).toBe('https://www.youtube.com/@veritasium')
	})

	test('prepends https to youtube.com URLs', () => {
		expect(toLookupUrl('youtube.com/@mkbhd')).toBe('https://youtube.com/@mkbhd')
		expect(toLookupUrl('www.youtube.com/@mkbhd')).toBe('https://www.youtube.com/@mkbhd')
	})

	test('preserves https URLs', () => {
		expect(toLookupUrl('https://www.youtube.com/@mkbhd')).toBe('https://www.youtube.com/@mkbhd')
	})
})

describe('resolveChannelId', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	test('returns raw channel ID immediately without calling axios', async () => {
		const id = 'UCcUNYFu8wNDncymesUOtPrg'
		const result = await resolveChannelId(id)
		expect(result).toBe(id)
		expect(axios.get).not.toHaveBeenCalled()
	})

	test('extracts channel ID from channel URL without axios', async () => {
		const url = 'https://www.youtube.com/channel/UCcUNYFu8wNDncymesUOtPrg'
		const result = await resolveChannelId(url)
		expect(result).toBe('UCcUNYFu8wNDncymesUOtPrg')
		expect(axios.get).not.toHaveBeenCalled()
	})

	test('fetches page and resolves handle to channel ID', async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: '<link rel="alternate" type="application/rss+xml" ' +
				'href="https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA">',
		} as any)

		const result = await resolveChannelId('@veritasium')
		expect(result).toBe('UCHnyfMqiRRG1u-2MsSQLbXA')
		expect(axios.get).toHaveBeenCalledWith(
			'https://www.youtube.com/@veritasium',
			expect.objectContaining({ responseType: 'text' }),
		)
	})

	test('throws clear error on HTTP 404', async () => {
		vi.mocked(axios.get).mockRejectedValueOnce({
			response: { status: 404 },
			message: 'Request failed with status code 404',
		})

		await expect(
			resolveChannelId('@nonexistent_channel_12345'),
		).rejects.toThrow(/YouTube channel or page not found \(HTTP 404\)/)
	})

	test('throws error if page has no recognizable channel ID', async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: '<html><body>Empty page</body></html>',
		} as any)

		await expect(resolveChannelId('@something')).rejects.toThrow(
			/Could not extract channel ID/,
		)
	})
})
