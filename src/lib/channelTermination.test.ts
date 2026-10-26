import { describe, test, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

import {
	isChannelTerminatedOnYouTube,
	handleTerminatedChannel,
} from './channelTermination'

vi.mock('axios')

describe('isChannelTerminatedOnYouTube', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	test('returns true on HTTP 404 status', async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			status: 404,
			data: 'Not found',
		} as any)

		const result =
			await isChannelTerminatedOnYouTube('UC0000000000000000000000')
		expect(result).toBe(true)
	})

	test('does not infer deletion from missing page metadata', async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			status: 200,
			data: '<html><head></head><body>Empty page</body></html>',
		} as any)

		const result =
			await isChannelTerminatedOnYouTube('UC0000000000000000000000')
		expect(result).toBe(false)
	})

	test.each([403, 429, 500, 503])('ignores HTTP %i failures', async status => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			status, data: 'Temporary failure',
		})
		expect(await isChannelTerminatedOnYouTube('UC1')).toBe(false)
	})

	test('recognizes an explicit termination error in channel data', async () => {
		const initial = { alerts: [{ alertRenderer: {
			type: 'ERROR', text: { runs: [{
				text: 'This account has been terminated for policy violations.',
			}] },
		} }] }
		vi.mocked(axios.get).mockResolvedValueOnce({
			status: 200,
			data: `<script>var ytInitialData = ${JSON.stringify(initial)};</script>`,
		})
		expect(await isChannelTerminatedOnYouTube('UC1')).toBe(true)
	})

	test('returns false when channel page is valid', async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			status: 200,
			data:
				'<html><head>' +
				'<link rel="canonical" href="https://www.youtube.com/channel/UC1">' +
				'<meta property="og:title" content="Valid Channel">' +
				'</head></html>',
		} as any)

		const result = await isChannelTerminatedOnYouTube('UC1')
		expect(result).toBe(false)
	})

	test('returns false on transient network error', async () => {
		vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network timeout'))

		const result = await isChannelTerminatedOnYouTube('UC1')
		expect(result).toBe(false)
	})
})

describe('handleTerminatedChannel', () => {
	test('updates database and sends alert email', async () => {
		const runMock = vi.fn().mockResolvedValue({})
		const db = { run: runMock } as any
		const sendErrorEmail = vi.fn().mockResolvedValue({})
		const logger = { warn: vi.fn(), error: vi.fn() } as any

		await handleTerminatedChannel(
			db,
			{ channelId: 'UC_dead', channelTitle: 'Terminated Creator' },
			sendErrorEmail,
			logger,
		)

		expect(runMock).toHaveBeenCalled()
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Terminated Creator'),
		)
		expect(sendErrorEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				subject: expect.stringContaining('Terminated Creator'),
				message: expect.stringContaining('no longer available on YouTube'),
			}),
		)
	})
})
