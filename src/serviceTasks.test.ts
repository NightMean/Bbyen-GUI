import { beforeEach, expect, test, vi } from 'vitest'
import { createServiceTasks } from './serviceTasks'
import { updateSubscriptions } from './subscriptions'
import { parseFeedsAndNotify } from './videos'
import { _resetAlertState } from './lib/alertState'
import { Config } from './config'
import { RefreshResult } from './refreshResult'

vi.mock('./subscriptions', () => ({ updateSubscriptions: vi.fn() }))
vi.mock('./videos', () => ({ parseFeedsAndNotify: vi.fn() }))

const success: RefreshResult = { status: 'success', total: 0, succeeded: 0,
	failed: 0, skipped: 0, failedChannels: [] }
const authFailure: RefreshResult = { ...success, status: 'failed',
	errorCategory: 'auth' }
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const mailers = { sendVideoEmail: vi.fn(), sendErrorEmail: vi.fn() }

beforeEach(() => { vi.resetAllMocks(); _resetAlertState() })

test('reloads OAuth credentials after the current client fails', async () => {
	const first = { client: 'first' }
	const second = { client: 'second' }
	const loadAuth = vi.fn().mockResolvedValueOnce(first)
		.mockResolvedValue(second)
	vi.mocked(updateSubscriptions).mockResolvedValueOnce(authFailure)
		.mockResolvedValue(success)
	const tasks = createServiceTasks({ db: {} as never, service: {} as never,
		config: { mode: 'youtube', logging: { emailOnError: false } } as Config,
		logger, loadMailers: vi.fn().mockResolvedValue(mailers), loadAuth })
	await tasks.runSubscriptions()
	await tasks.runSubscriptions()
	expect(loadAuth).toHaveBeenCalledTimes(2)
	expect(vi.mocked(updateSubscriptions).mock.calls.map(call => call[0].auth))
		.toEqual([first, second])
})

test('pauses video checks until SMTP becomes available', async () => {
	const loadMailers = vi.fn().mockRejectedValueOnce(new Error('fixture'))
		.mockResolvedValue(mailers)
	vi.mocked(parseFeedsAndNotify).mockResolvedValue(success)
	const tasks = createServiceTasks({ db: {} as never, service: {} as never,
		config: { mode: 'whitelist', logging: { emailOnError: false } } as Config,
		logger, loadMailers, loadAuth: vi.fn() })
	expect((await tasks.runVideos()).status).toBe('failed')
	expect(parseFeedsAndNotify).not.toHaveBeenCalled()
	expect((await tasks.runVideos()).status).toBe('success')
	expect(parseFeedsAndNotify).toHaveBeenCalledTimes(1)
})

test('defers quota emails until retries are exhausted', async () => {
	const notify = vi.fn().mockResolvedValue(undefined)
	const alerts = { notify, clear: vi.fn().mockResolvedValue(undefined) }
	vi.mocked(updateSubscriptions).mockImplementation(async args => {
		await args.alerts!.notify('quota', new Error('fixture'), {
			source: 'subscriptions', emailOnError: true, logger,
			sendErrorEmail: mailers.sendErrorEmail,
		})
		return { ...authFailure, errorCategory: 'quota' }
	})
	const tasks = createServiceTasks({ db: {} as never, service: {} as never,
		config: { mode: 'youtube', logging: { emailOnError: true } } as Config,
		logger, alerts, loadMailers: vi.fn().mockResolvedValue(mailers),
		loadAuth: vi.fn().mockResolvedValue({}) })
	await tasks.runSubscriptions()
	expect(notify.mock.calls[0][2].emailOnError).toBe(false)
	await tasks.reportQuota()
	expect(notify.mock.calls[1][2].emailOnError).toBe(true)
})
