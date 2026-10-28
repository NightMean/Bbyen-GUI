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

test('reloads a replaced grant without restarting and shares concurrent loads',
	async () => {
		let revision = 'first'
		const first = { client: 'first' }, second = { client: 'second' }
		let release!: () => void
		const loadAuth = vi.fn().mockResolvedValueOnce(first)
			.mockImplementationOnce(async () => {
				await new Promise<void>(resolve => { release = resolve })
				return second
			})
		vi.mocked(updateSubscriptions).mockResolvedValue(success)
		const tasks = createServiceTasks({ db: {} as never, service: {} as never,
			config: { mode: 'youtube', logging: { emailOnError: false } } as Config,
			logger, loadMailers: vi.fn().mockResolvedValue(mailers), loadAuth,
			authRevision: async () => revision })
		await tasks.runSubscriptions()
		revision = 'second'
		const a = tasks.runSubscriptions(), b = tasks.runSubscriptions()
		while (!release) await new Promise(resolve => setTimeout(resolve, 1))
		release()
		await Promise.all([a, b])
		expect(loadAuth).toHaveBeenCalledTimes(2)
		expect(vi.mocked(updateSubscriptions).mock.calls.map(call => call[0].auth))
			.toEqual([first, second, second])
	})

test('does not install a grant replaced while it is being loaded', async () => {
	let revision = 'first'
	const stale = { client: 'stale' }, current = { client: 'current' }
	const loadAuth = vi.fn().mockImplementationOnce(async () => {
		revision = 'second'
		return stale
	}).mockResolvedValue(current)
	vi.mocked(updateSubscriptions).mockResolvedValue(success)
	const tasks = createServiceTasks({ db: {} as never, service: {} as never,
		config: { mode: 'youtube', logging: { emailOnError: false } } as Config,
		logger, loadMailers: vi.fn().mockResolvedValue(mailers), loadAuth,
		authRevision: async () => revision })
	await tasks.runSubscriptions()
	expect(loadAuth).toHaveBeenCalledTimes(2)
	expect(vi.mocked(updateSubscriptions).mock.calls[0][0].auth).toBe(current)
})

test('an older failed request does not invalidate a newer grant', async () => {
	let revision = 'first'
	const first = { client: 'first' }, second = { client: 'second' }
	const loadAuth = vi.fn().mockResolvedValueOnce(first)
		.mockResolvedValue(second)
	let failFirst!: () => void
	vi.mocked(updateSubscriptions).mockImplementationOnce(async () => {
		await new Promise<void>(resolve => { failFirst = resolve })
		return authFailure
	}).mockResolvedValue(success)
	const tasks = createServiceTasks({ db: {} as never, service: {} as never,
		config: { mode: 'youtube', logging: { emailOnError: false } } as Config,
		logger, loadMailers: vi.fn().mockResolvedValue(mailers), loadAuth,
		authRevision: async () => revision })
	const oldRequest = tasks.runSubscriptions()
	while (!failFirst) await new Promise(resolve => setTimeout(resolve, 1))
	revision = 'second'
	await tasks.runSubscriptions()
	failFirst()
	await oldRequest
	await tasks.runSubscriptions()
	expect(loadAuth).toHaveBeenCalledTimes(2)
	expect(vi.mocked(updateSubscriptions).mock.calls[2][0].auth).toBe(second)
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

test('checks API channels through RSS when authorization fails', async () => {
	vi.mocked(parseFeedsAndNotify).mockResolvedValue(success)
	const tasks = createServiceTasks({ db: {} as never, service: {} as never,
		config: { mode: 'youtube', logging: { emailOnError: false } } as Config,
		logger, loadMailers: vi.fn().mockResolvedValue(mailers),
		loadAuth: vi.fn().mockRejectedValue(new Error('expired')) })
	expect(await tasks.runVideos()).toMatchObject({ status: 'partial',
		errorCategory: 'auth', apiChecked: false })
	expect(vi.mocked(parseFeedsAndNotify).mock.calls[0][0].rssOnly).toBe(true)
})

test('reports API account verification throttling to the quota scheduler',
	async () => {
		const tasks = createServiceTasks({ db: {} as never, service: {} as never,
			config: { mode: 'youtube', logging: { emailOnError: false } } as Config,
			logger, loadMailers: vi.fn().mockResolvedValue(mailers),
			loadAuth: vi.fn().mockResolvedValue({}),
			verifyApiAuth: vi.fn().mockRejectedValue({ response: { status: 429 } }),
		})
		expect(await tasks.runSubscriptions()).toMatchObject({ status: 'failed',
			errorCategory: 'quota' })
		expect(await tasks.runVideos()).toMatchObject({ status: 'failed',
			errorCategory: 'quota' })
		expect(parseFeedsAndNotify).not.toHaveBeenCalled()
	})

test('uses cookie reconciliation without OAuth credentials', async () => {
	const refreshCookies = vi.fn().mockResolvedValue(success)
	const loadAuth = vi.fn()
	const tasks = createServiceTasks({ db: {} as never, service: {} as never,
		config: { mode: 'cookie', logging: { emailOnError: false } } as Config,
		logger, loadMailers: vi.fn().mockResolvedValue(mailers), loadAuth,
		refreshCookies })
	expect((await tasks.runSubscriptions()).status).toBe('success')
	expect(refreshCookies).toHaveBeenCalledTimes(1)
	expect(loadAuth).not.toHaveBeenCalled()
})

test('pauses refreshes while a confirmed manual switch is recovering',
	async () => {
		const loadAuth = vi.fn()
		const tasks = createServiceTasks({ db: {} as never, service: {} as never,
			config: { mode: 'youtube', manualTransitionPending: true,
				logging: { emailOnError: true } } as Config,
			logger, loadAuth, loadMailers: vi.fn().mockResolvedValue(mailers) })
		expect((await tasks.runSubscriptions()).status).toBe('failed')
		expect((await tasks.runVideos()).status).toBe('failed')
		expect((await tasks.runRssVideos()).status).toBe('failed')
		expect(loadAuth).not.toHaveBeenCalled()
		expect(updateSubscriptions).not.toHaveBeenCalled()
		expect(parseFeedsAndNotify).not.toHaveBeenCalled()
	})

test('combined mode preserves cookie tracking when Google identity fails',
	async () => {
		const refreshCookies = vi.fn().mockResolvedValue(success)
		const metadata = vi.fn()
		const alerts = { notify: vi.fn(), clear: vi.fn() }
		vi.mocked(parseFeedsAndNotify).mockResolvedValue(success)
		const tasks = createServiceTasks({ db: {} as never, service: {} as never,
			config: { mode: 'cookie', apiEnrichment: true,
				logging: { emailOnError: false } } as Config,
			logger, alerts, loadMailers: vi.fn().mockResolvedValue(mailers),
			loadAuth: vi.fn().mockResolvedValue({}), refreshCookies,
			verifyCombinedAuth: vi.fn().mockRejectedValue(new Error('mismatch')),
			refreshCombinedMetadata: metadata })
		expect(await tasks.runSubscriptions()).toMatchObject({ status: 'partial',
			errorCategory: 'auth' })
		expect(refreshCookies).toHaveBeenCalledTimes(1)
		expect(metadata).not.toHaveBeenCalled()
		expect(await tasks.runVideos()).toMatchObject({ status: 'partial',
			errorCategory: 'auth' })
		expect(vi.mocked(parseFeedsAndNotify).mock.calls[0][0].rssOnly).toBe(true)
	})

test('combined metadata omissions are reported while cookie tracking continues',
	async () => {
		const refreshCookies = vi.fn().mockResolvedValue(success)
		const notify = vi.fn()
		const tasks = createServiceTasks({ db: {} as never, service: {} as never,
			config: { mode: 'cookie', apiEnrichment: true,
				logging: { emailOnError: true } } as Config,
			logger, alerts: { notify, clear: vi.fn() },
			loadMailers: vi.fn().mockResolvedValue(mailers),
			loadAuth: vi.fn().mockResolvedValue({}), refreshCookies,
			verifyCombinedAuth: vi.fn().mockResolvedValue(undefined),
			refreshCombinedMetadata: vi.fn().mockResolvedValue({
				matched: 1, total: 2 }),
		})
		expect(await tasks.runSubscriptions()).toMatchObject({ status: 'partial',
			errorCategory: 'other', apiChecked: true })
		expect(notify).toHaveBeenCalledWith('other', expect.any(Error),
			expect.objectContaining({ source: 'combined-api', emailOnError: true }))
	})

test('combined identity quota failures use quota backoff and defer email',
	async () => {
		const notify = vi.fn()
		const tasks = createServiceTasks({ db: {} as never, service: {} as never,
			config: { mode: 'cookie', apiEnrichment: true,
				logging: { emailOnError: true } } as Config,
			logger, alerts: { notify, clear: vi.fn() },
			loadMailers: vi.fn().mockResolvedValue(mailers),
			loadAuth: vi.fn().mockResolvedValue({}),
			refreshCookies: vi.fn().mockResolvedValue(success),
			verifyCombinedAuth: vi.fn().mockRejectedValue({
				response: { status: 429 } }),
		})
		expect(await tasks.runSubscriptions()).toMatchObject({ status: 'partial',
			errorCategory: 'quota' })
		expect(await tasks.runVideos()).toMatchObject({ status: 'failed',
			errorCategory: 'quota' })
		expect(notify).toHaveBeenCalledWith('quota', expect.any(Error),
			expect.objectContaining({ emailOnError: false }))
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
