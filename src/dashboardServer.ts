import { randomUUID } from 'crypto'
import { createServer, RequestListener, Server } from 'http'
import * as sqlite from 'sqlite'
import { RefreshCoordinator, RefreshKind } from './refreshCoordinator'
import { isChannelId } from './lib/channelId'
import { listDashboardVideos, parseVideoQuery } from './dashboardVideos'
import { BacklogPolicy, parseBacklogPolicy } from './initialBacklog'
import {
	PublicEmailSettings, parseEmailCredentials, parseEmailSettings,
} from './emailSettings'
import { serveDashboardAsset } from './dashboardAssets'
import { exportSubscriptions } from './subscriptionExport'
import type { Config } from './config'
import { parseSubscriptionImport } from './subscriptionImport'
import {
	ImportChangedError, ImportConfirmationError, SubscriptionImportService,
} from './subscriptionImportService'

interface ChannelActions {
	add: (channelId: string, initialBacklog?: BacklogPolicy) => Promise<void>,
	resolve: (input: string) => Promise<string>,
	refresh: (kind: RefreshKind) => void,
	setNotify: (channelId: string, notify: boolean) => Promise<void>,
	remove: (channelId: string) => Promise<void>,
	manualMode: () => boolean,
	manualNotify: (channelId: string) => boolean | null,
	emailSettings: () => { settings: PublicEmailSettings,
		userFromEnvironment: boolean, passFromEnvironment: boolean },
	saveEmail: (settings: PublicEmailSettings) => Promise<void>,
	saveCredentials: (value: unknown) => Promise<void>,
	testEmail: () => Promise<'sent' | 'uncertain'>,
	config: Config,
	imports: SubscriptionImportService,
}

/** Dashboard API. Database work shares the refresh queue. */
export const createDashboardHandler = (
	db: sqlite.Database, jobs: RefreshCoordinator, actions?: ChannelActions,
): RequestListener => (request, response) => {
	response.setHeader('Content-Type', 'application/json; charset=utf-8')
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('X-Content-Type-Options', 'nosniff')
	const send = (status: number, value: unknown) => {
		response.writeHead(status)
		response.end(JSON.stringify(value))
	}
	let url: URL
	try { url = new URL(request.url ?? '/', 'http://localhost') } catch {
		send(400, { error: 'Invalid request.' })
		return
	}
	if (serveDashboardAsset(request, response, url)) return
	if (request.method === 'POST' && !url.search && actions &&
			(url.pathname === '/api/channels' ||
			url.pathname === '/api/channels/resolve' ||
			url.pathname === '/api/channels/notify' ||
			url.pathname === '/api/channels/remove' ||
			url.pathname === '/api/email/settings' ||
			url.pathname === '/api/email/credentials' ||
			url.pathname === '/api/email/test' ||
			url.pathname === '/api/subscriptions/import/preview' ||
			url.pathname === '/api/subscriptions/import/apply' ||
			url.pathname === '/api/refresh')) {
		const origin = request.headers.origin
		if ((origin && origin !== `http://${request.headers.host}` &&
				origin !== `https://${request.headers.host}`) ||
				request.headers['content-type'] !== 'application/json') {
			send(403, { error: 'Request origin or content type is invalid.' })
			return
		}
		let body = ''
		request.setEncoding('utf8')
		request.on('data', chunk => {
			body += chunk
			const limit = url.pathname === '/api/subscriptions/import/preview'
				? 2 * 1024 * 1024 : 8192
			if (body.length > limit) request.destroy()
		})
		request.on('end', () => {
			let data: { channelId?: unknown, input?: unknown, kind?: unknown,
				notify?: unknown, initialBacklog?: unknown, settings?: unknown,
				credentials?: unknown, importData?: unknown, previewId?: unknown,
				conflictChoice?: unknown, acceptPartial?: unknown } = {}
			try {
				const parsed: unknown = JSON.parse(body)
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error('Expected an object.')
				}
				data = parsed
			} catch { send(400, { error: 'Expected a JSON object.' }); return }
			if (url.pathname === '/api/subscriptions/import/preview') {
				try { parseSubscriptionImport(data.importData) } catch {
					send(400, { error: 'Subscription file is invalid.' }); return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.imports.preview(data.importData)).then(result =>
					send(200, result), () => send(500, {
					error: 'Could not preview the current channel configuration.',
				}))
				return
			}
			if (url.pathname === '/api/subscriptions/import/apply') {
				const id = data.previewId
				const choice = data.conflictChoice
				if (typeof id !== 'string' ||
						(choice !== 'keep' && choice !== 'replace') ||
						typeof data.acceptPartial !== 'boolean') {
					send(400, { error: 'Invalid import confirmation.' }); return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.imports.apply(id, choice, data.acceptPartial as boolean))
					.then(() => {
						actions.refresh('subscriptions'); send(200, { applied: true })
					}, err => {
						const status = err instanceof ImportChangedError ? 409 :
							err instanceof ImportConfirmationError ? 400 : 500
						send(status, { error: 'Import failed. Review the preview again.' })
					})
				return
			}
			if (url.pathname === '/api/email/test') {
				void jobs.maintenance(randomUUID(), actions.testEmail).then(
					outcome => send(200, { outcome }),
					() => send(500, { error: 'Could not confirm the test outcome.' }))
				return
			}
			if (url.pathname === '/api/email/settings') {
				let settings: PublicEmailSettings
				try { settings = parseEmailSettings(data.settings) } catch {
					send(400, { error: 'Enter valid email settings.' }); return
				}
				void jobs.maintenance(randomUUID(), () => actions.saveEmail(settings))
					.then(() => send(200, { saved: true }),
						() => send(500, { error: 'Could not save email settings.' }))
				return
			}
			if (url.pathname === '/api/email/credentials') {
				try { parseEmailCredentials(data.credentials) } catch {
					send(400, { error: 'Check credentials and environment settings.' })
					return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.saveCredentials(data.credentials))
					.then(() => send(200, { saved: true }), () => send(500, {
						error: 'Could not save credentials. Check service storage.',
					}))
				return
			}
			if (url.pathname === '/api/refresh') {
				if (data.kind !== 'subscriptions' && data.kind !== 'videos') {
					send(400, { error: 'Choose a valid refresh type.' })
					return
				}
				actions.refresh(data.kind)
				send(202, { kind: data.kind })
				return
			}
			if (url.pathname === '/api/channels/resolve') {
				if (typeof data.input !== 'string' || !data.input.trim() ||
						data.input.length > 2048) {
					send(400, { error: 'Enter a YouTube channel, video, or feed.' })
					return
				}
				void actions.resolve(data.input).then(channelId => {
					if (!isChannelId(channelId)) {
						send(422, { error: 'Could not resolve this YouTube address.' })
						return
					}
					send(200, { channelId })
				}, () => send(422, {
					error: 'Could not resolve this YouTube address.',
				}))
				return
			}
			const id = data.channelId
			if (typeof id !== 'string' || !isChannelId(id)) {
				send(400, { error: 'A valid channel ID is required.' })
				return
			}
			if (url.pathname === '/api/channels/notify') {
				if (!actions.manualMode() || typeof data.notify !== 'boolean') {
					send(400, { error: 'Notification setting is unavailable.' })
					return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.setNotify(id, data.notify as boolean)).then(() =>
					send(200, { channelId: id, notify: data.notify }),
				() => send(500, { error: 'Could not save notification setting.' }))
				return
			}
			if (url.pathname === '/api/channels/remove') {
				if (!actions.manualMode()) {
					send(400, { error: 'Manual removal is unavailable.' })
					return
				}
				void jobs.maintenance(randomUUID(), () => actions.remove(id))
					.then(() => {
						actions.refresh('subscriptions')
						send(202, { channelId: id })
					}, () => send(500, { error: 'Could not remove the channel.' }))
				return
			}
			let backlog: BacklogPolicy | undefined
			try {
				if (data.initialBacklog !== undefined) {
					backlog = parseBacklogPolicy(data.initialBacklog, 'initialBacklog')
				}
			} catch {
				send(400, { error: 'Invalid initial video preference.' })
				return
			}
			void jobs.maintenance(randomUUID(), () => actions.add(id, backlog))
				.then(() => {
					actions.refresh('subscriptions')
					send(202, { channelId: id })
				},
				() => send(500, { error: 'Could not save the channel.' }))
		})
		return
	}
	if (request.method !== 'GET') {
		response.setHeader('Allow', 'GET')
		send(405, { error: 'Method not allowed.' })
		return
	}
	if ((url.search && url.pathname !== '/api/videos') ||
			!['/api/health', '/api/channels', '/api/videos',
				'/api/refresh', '/api/incidents', '/api/email/settings',
				'/api/email/tests', '/api/subscriptions/export']
				.includes(url.pathname)) {
		send(404, { error: 'Not found.' })
		return
	}
	if (url.pathname === '/api/health') {
		send(200, { status: 'running' })
		return
	}
	if (url.pathname === '/api/email/settings') {
		if (!actions) {
			send(503, { error: 'Email settings unavailable.' })
			return
		}
		send(200, actions.emailSettings())
		return
	}
	if (url.pathname === '/api/refresh') {
		// Status must remain observable while a long-running job owns the queue.
		void Promise.all([jobs.status('subscriptions'), jobs.status('videos')])
			.then(([subscriptions, videos]) => send(200, { subscriptions, videos }),
				() => send(500, { error: 'Refresh status is unavailable.' }))
		return
	}
	let query: ReturnType<typeof parseVideoQuery>
	try { query = parseVideoQuery(url.searchParams) } catch {
		send(400, { error: 'Invalid video filters.' })
		return
	}
	void jobs.maintenance(randomUUID(), async () => {
		if (url.pathname === '/api/subscriptions/export') {
			if (!actions) throw new Error('Subscription export unavailable.')
			return exportSubscriptions(actions.config)
		}
		if (url.pathname === '/api/email/tests') {
			return { tests: await db.all(`SELECT id, startedAt, finishedAt, outcome
				FROM email_test_runs ORDER BY startedAt DESC, rowid DESC LIMIT 20`) }
		}
		if (url.pathname === '/api/incidents') {
			return { incidents: await db.all(`SELECT id, source, category, channelId,
				openedAt, lastObservedAt, resolvedAt, occurrences, emailState
				FROM incidents ORDER BY resolvedAt IS NULL DESC, lastObservedAt DESC
				LIMIT 100`) }
		}
		if (url.pathname === '/api/channels') {
			const channels = await db.all(`SELECT channelId, channelTitle,
				channelThumbnail, deleted, deletedReason, firstObservedAt, bellState,
				bellUpdatedAt FROM subscriptions ORDER BY channelTitle, channelId
				LIMIT 500`)
			const manualMode = actions?.manualMode() ?? false
			return { manualMode, channels: channels.map(channel => ({ ...channel,
				...(manualMode ? { notify: actions?.manualNotify(channel.channelId) }
					: {}),
			})) }
		}
		return listDashboardVideos(db, query)
	}).then(result => {
		if (url.pathname === '/api/subscriptions/export') {
			response.setHeader('Content-Disposition',
				'attachment; filename="bbyen-subscriptions.json"')
		}
		send(200, result)
	}, () => {
		send(500, { error: 'Dashboard data is temporarily unavailable.' })
	})
}

export const createDashboardServer = (
	db: sqlite.Database, jobs: RefreshCoordinator, actions?: ChannelActions,
): Server => createServer(createDashboardHandler(db, jobs, actions))

export const dashboardPort = (value: string | undefined): number => {
	if (value === undefined) return 3031
	if (!/^\d+$/.test(value)) throw new Error('Invalid BBYEN_DASHBOARD_PORT.')
	const port = Number(value)
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error('Invalid BBYEN_DASHBOARD_PORT.')
	}
	return port
}
