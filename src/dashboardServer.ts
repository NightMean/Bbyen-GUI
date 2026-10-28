import { randomUUID } from 'crypto'
import { createServer, RequestListener, Server } from 'http'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { RefreshCoordinator, RefreshKind } from './refreshCoordinator'
import { isChannelId } from './lib/channelId'
import { listDashboardVideos, parseVideoQuery } from './dashboardVideos'
import { listActivity, parseActivityPage } from './dashboardActivity'
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
import { parseRefreshIntervals, RefreshIntervals } from './refreshSchedule'
import {
	GeneralSettings, parseGeneralSettings, readGeneralSettings,
} from './generalSettings'
import { CookiePreviewService } from './cookiePreview'
import { ManualSourceSwitch } from './manualSourceSwitch'
import { CookieBellActions } from './cookieBellActions'
import { CookieSubscriptionActions } from './cookieSubscriptionActions'
import { BellNotificationPreference } from './lib/innertubeChannels'
import { ApiChannelList } from './apiChannelLists'
import { makeEmailEligibility } from './emailPolicy'

interface ChannelActions {
	add: (channelId: string, initialBacklog?: BacklogPolicy) => Promise<void>,
	resolve: (input: string) => Promise<string>,
	refresh: (kind: RefreshKind) => void,
	setNotify: (channelId: string, notify: boolean) => Promise<void>,
	setApiList: (channelId: string, list: ApiChannelList,
		included: boolean) => Promise<void>,
	remove: (channelId: string) => Promise<void>,
	manualMode: () => boolean,
	channelNotify: (channelId: string) => boolean | null,
	emailSettings: () => { settings: PublicEmailSettings,
		userFromEnvironment: boolean, passFromEnvironment: boolean },
	saveEmail: (settings: PublicEmailSettings) => Promise<void>,
	saveCredentials: (value: unknown) => Promise<void>,
	testEmail: () => Promise<'sent' | 'uncertain'>,
	config: Config,
	imports: SubscriptionImportService,
	saveSchedule: (value: RefreshIntervals) => Promise<void>,
	saveGeneral: (value: GeneralSettings) => Promise<void>,
	saveUnsubscribePreference: (value: boolean) => Promise<void>,
	cookiePreviews: CookiePreviewService,
	cookieStatus: () => Promise<unknown>,
	activateCookie: (candidateId: string, previewId: string) => Promise<void>,
	manualSwitch: ManualSourceSwitch,
	cookieCleanupPending: () => Promise<boolean>,
	bellActions: CookieBellActions,
	subscriptionActions: CookieSubscriptionActions,
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
			url.pathname === '/api/channels/email-list' ||
			url.pathname === '/api/channels/remove' ||
			url.pathname === '/api/channels/bell' ||
			url.pathname === '/api/channels/bell/review' ||
			url.pathname === '/api/channels/bell/acknowledge' ||
			url.pathname === '/api/channels/subscription' ||
			url.pathname === '/api/channels/subscription/review' ||
			url.pathname === '/api/channels/subscription/undo' ||
			url.pathname === '/api/channels/subscription/undo/acknowledge' ||
			url.pathname === '/api/channels/subscription/acknowledge' ||
			url.pathname === '/api/email/settings' ||
			url.pathname === '/api/email/credentials' ||
			url.pathname === '/api/email/test' ||
			url.pathname === '/api/subscriptions/import/preview' ||
			url.pathname === '/api/subscriptions/import/apply' ||
			url.pathname === '/api/schedule' ||
			url.pathname === '/api/settings' ||
			url.pathname === '/api/unsubscribe-confirmation' ||
			url.pathname === '/api/cookies/inspect' ||
			url.pathname === '/api/cookies/compare' ||
			url.pathname === '/api/cookies/activate' ||
			url.pathname === '/api/cookies/cancel' ||
			url.pathname === '/api/cookies/manual/preview' ||
			url.pathname === '/api/cookies/manual/apply' ||
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
				? 2 * 1024 * 1024 : url.pathname === '/api/cookies/inspect'
					? 512 * 1024 : 8192
			if (body.length > limit) request.destroy()
		})
		request.on('end', () => {
			let data: { channelId?: unknown, input?: unknown, kind?: unknown,
				notify?: unknown, initialBacklog?: unknown, settings?: unknown,
				credentials?: unknown, importData?: unknown, previewId?: unknown,
				conflictChoice?: unknown, acceptPartial?: unknown,
				intervals?: unknown, cookie?: unknown, candidateId?: unknown,
				profileId?: unknown, preference?: unknown, subscribed?: unknown,
				confirmUnsubscribe?: unknown, list?: unknown, included?: unknown } = {}
			try {
				const parsed: unknown = JSON.parse(body)
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error('Expected an object.')
				}
				data = parsed
			} catch { send(400, { error: 'Expected a JSON object.' }); return }
			if (url.pathname.startsWith('/api/cookies/')) {
				if (url.pathname === '/api/cookies/manual/preview') {
					void jobs.maintenance(randomUUID(), () =>
						actions.manualSwitch.preview()).then(result => send(200, result),
						() => send(409, { error: 'Could not preview the source switch.' }))
					return
				}
				if (url.pathname === '/api/cookies/manual/apply') {
					if (typeof data.previewId !== 'string' || !data.previewId) {
						send(400, { error: 'Source switch preview is missing.' }); return
					}
					const preview = data.previewId
					void jobs.maintenance(randomUUID(), () =>
						actions.manualSwitch.apply(preview)).then(result =>
						send(200, { switched: true, ...result }), () => send(409, {
						error: 'Could not confirm the switch. Review the preview again.',
					}))
					return
				}
				if (actions.config.mode === 'youtube') {
					send(409, { error: 'API-to-cookie switching is unavailable.' })
					return
				}
				if (url.pathname === '/api/cookies/inspect') {
					if (typeof data.cookie !== 'string' || !data.cookie ||
							data.cookie.length > 256 * 1024) {
						send(400, { error: 'Enter a valid YouTube cookie.' }); return
					}
					void actions.cookiePreviews.inspect(data.cookie).then(result =>
						send(200, result), () => send(422, {
						error: 'Could not verify the cookie or account profiles.',
					}))
					return
				}
				if (typeof data.candidateId !== 'string' || !data.candidateId) {
					send(400, { error: 'Cookie preview is missing.' }); return
				}
				const candidate = data.candidateId
				if (url.pathname === '/api/cookies/cancel') {
					actions.cookiePreviews.cancel(candidate)
					send(200, { cancelled: true })
					return
				}
				if (url.pathname === '/api/cookies/compare') {
					if (typeof data.profileId !== 'string' || !data.profileId) {
						send(400, { error: 'Choose an available profile.' }); return
					}
					const profile = data.profileId
					void jobs.maintenance(randomUUID(), () =>
						actions.cookiePreviews.compare(candidate, profile)).then(result =>
						send(200, result), () => send(422, {
						error: 'Could not compare channels for this profile.',
					}))
					return
				}
				if (typeof data.previewId !== 'string' || !data.previewId) {
					send(400, { error: 'Cookie comparison is missing.' }); return
				}
				const preview = data.previewId
				void jobs.maintenance(randomUUID(), () =>
					actions.activateCookie(candidate, preview)).then(() => {
					actions.refresh('videos'); send(200, { connected: true })
				}, () => send(409, {
					error: 'Could not confirm the connection. Review the preview again.',
				}))
				return
			}
			if (url.pathname === '/api/unsubscribe-confirmation') {
				if (typeof data.confirmUnsubscribe !== 'boolean') {
					send(400, { error: 'Choose a confirmation setting.' }); return
				}
				const enabled = data.confirmUnsubscribe
				void jobs.maintenance(randomUUID(), () =>
					actions.saveUnsubscribePreference(enabled)).then(() =>
					send(200, { confirmUnsubscribe: enabled }), () => send(500, {
					error: 'Could not confirm the saved setting.',
				}))
				return
			}
			if (url.pathname === '/api/settings') {
				try { parseGeneralSettings(data.settings) } catch {
					send(400, { error: 'Enter valid settings.' }); return
				}
				void jobs.maintenance(randomUUID(), async () => {
					const input = data.settings as Record<string, unknown>
					const settings = parseGeneralSettings({ ...input,
						emailSelectionPolicy: input.emailSelectionPolicy ??
							actions.config.emailSelectionPolicy ?? null,
						videoViewDays: input.videoViewDays ??
							actions.config.videoViewDays ?? 7,
						activityRetentionDays: input.activityRetentionDays === undefined ?
							actions.config.activityRetentionDays ?? null :
							input.activityRetentionDays,
						confirmUnsubscribe: input.confirmUnsubscribe ??
							actions.config.confirmUnsubscribe ?? true,
						notifyTitleChanges: input.notifyTitleChanges ??
							actions.config.notifyTitleChanges ?? true,
						notifyChannelAdded: input.notifyChannelAdded ??
							actions.config.notifyChannelAdded ?? true,
						notifyFailureReminders: input.notifyFailureReminders ??
							actions.config.notifyFailureReminders ?? false,
						notifyRecoveries: input.notifyRecoveries ??
							actions.config.notifyRecoveries ?? false })
					const changedPolicy = settings.emailSelectionPolicy !==
						(actions.config.emailSelectionPolicy ?? null)
					await actions.saveGeneral(settings)
					return { settings, changedPolicy }
				})
					.then(({ settings, changedPolicy }) => {
						if (changedPolicy && actions.config.mode === 'youtube') {
							actions.refresh('subscriptions')
						}
						send(200, { settings })
					}, () => send(500, {
						error: 'Could not confirm settings. Reload before retrying.',
					}))
				return
			}
			if (url.pathname === '/api/schedule') {
				let intervals: RefreshIntervals
				try {
					intervals = parseRefreshIntervals(data.intervals).intervals
				} catch {
					send(400, { error: 'Enter valid refresh intervals.' }); return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.saveSchedule(intervals))
					.then(() => send(200, { intervals }), () => send(500, {
						error: 'Could not confirm saved intervals. Reload before retrying.',
					}))
				return
			}
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
			if (url.pathname === '/api/channels/email-list') {
				if ((data.list !== 'allowlist' && data.list !== 'blocklist') ||
						typeof data.included !== 'boolean') {
					send(400, { error: 'Choose a list and membership.' }); return
				}
				const list = data.list, included = data.included
				void jobs.maintenance(randomUUID(), () =>
					actions.setApiList(id, list, included)).then(() =>
					send(200, { channelId: id, list, included }), () => send(409, {
					error: 'Could not save the channel list. Reload and try again.',
				}))
				return
			}
			if (url.pathname === '/api/channels/notify') {
				if ((!actions.manualMode() && actions.config.mode !== 'cookie' &&
						actions.config.mode !== 'youtube') ||
						typeof data.notify !== 'boolean') {
					send(400, { error: 'Notification setting is unavailable.' })
					return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.setNotify(id, data.notify as boolean)).then(() =>
					send(200, { channelId: id, notify: data.notify }),
				() => send(500, { error: 'Could not save notification setting.' }))
				return
			}
			if (url.pathname === '/api/channels/bell/review') {
				void jobs.maintenance(randomUUID(), () =>
					actions.bellActions.review(id))
					.then(result => send(200, result), () => send(409, {
						error: 'Could not verify the account and bell state.',
					}))
				return
			}
			if (url.pathname === '/api/channels/subscription/undo/acknowledge') {
				void jobs.maintenance(randomUUID(), () =>
					actions.subscriptionActions.acknowledgeUndo(id)).then(() =>
					send(200, { acknowledged: true }), () => send(409, {
					error: 'Review unresolved YouTube requests first.',
				}))
				return
			}
			if (url.pathname === '/api/channels/subscription/undo') {
				void jobs.maintenance(randomUUID(), () =>
					actions.subscriptionActions.undo(id, (channelId, preference) =>
						actions.bellActions.change(channelId, preference, true)))
					.then(outcome => send(200, outcome), () => send(409, {
						error: 'Could not undo the YouTube unsubscribe.',
					}))
				return
			}
			if (url.pathname === '/api/channels/subscription/review') {
				void jobs.maintenance(randomUUID(), () =>
					actions.subscriptionActions.review(id)).then(result =>
					send(200, result), () => send(409, {
					error: 'Could not verify the account and subscription.',
				}))
				return
			}
			if (url.pathname === '/api/channels/subscription' ||
					url.pathname === '/api/channels/subscription/acknowledge') {
				if (typeof data.subscribed !== 'boolean') {
					send(400, { error: 'Choose a valid subscription action.' }); return
				}
				const subscribed = data.subscribed
				if (url.pathname.endsWith('/acknowledge')) {
					void jobs.maintenance(randomUUID(), () =>
						actions.subscriptionActions.acknowledge(id, subscribed)).then(() =>
						send(200, { acknowledged: true }), () => send(409, {
						error: 'Could not verify the account and subscription.',
					}))
					return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.subscriptionActions.change(id, subscribed)).then(outcome =>
					send(200, { outcome }), () => send(409, {
					error: 'Could not verify the account and subscription.',
				}))
				return
			}
			if (url.pathname === '/api/channels/bell' ||
					url.pathname === '/api/channels/bell/acknowledge') {
				if (data.preference !== 'all' && data.preference !== 'personalized' &&
						data.preference !== 'none') {
					send(400, { error: 'Choose a valid bell preference.' }); return
				}
				const preference: BellNotificationPreference = data.preference
				if (url.pathname.endsWith('/acknowledge')) {
					void jobs.maintenance(randomUUID(), () =>
						actions.bellActions.acknowledge(id, preference)).then(() =>
						send(200, { acknowledged: true }), () => send(409, {
						error: 'Could not verify the account and bell state.',
					}))
					return
				}
				void jobs.maintenance(randomUUID(), () =>
					actions.bellActions.change(id, preference)).then(outcome =>
					send(200, { outcome }), () => send(409, {
					error: 'Could not verify or change this YouTube bell.',
				}))
				return
			}
			if (url.pathname === '/api/channels/remove') {
				if (!actions.manualMode() && !(actions.config.mode === 'youtube' &&
						actions.config.emailSelectionPolicy)) {
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
			void jobs.maintenance(randomUUID(), async () => {
				if (!actions.manualMode() && !(actions.config.mode === 'youtube' &&
						actions.config.emailSelectionPolicy)) return false
				await actions.add(id, backlog)
				return true
			}).then(added => {
				if (!added) {
					send(409, { error: 'Channel addition is unavailable in this mode.' })
					return
				}
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
	if ((url.search &&
			!['/api/videos', '/api/activity'].includes(url.pathname)) ||
			!['/api/health', '/api/channels', '/api/videos',
				'/api/refresh', '/api/incidents', '/api/email/settings',
				'/api/email/tests', '/api/subscriptions/export', '/api/schedule',
				'/api/settings', '/api/cookies/status', '/api/channel-events',
				'/api/title-events', '/api/channel-added-events', '/api/activity']
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
	if (url.pathname === '/api/schedule') {
		if (!actions) { send(503, { error: 'Schedule unavailable.' }); return }
		send(200, { intervals: actions.config.timers })
		return
	}
	if (url.pathname === '/api/settings') {
		if (!actions) { send(503, { error: 'Settings unavailable.' }); return }
		send(200, { settings: readGeneralSettings(actions.config) })
		return
	}
	if (url.pathname === '/api/cookies/status' && !actions) {
		send(503, { error: 'Cookie connection status unavailable.' })
		return
	}
	if (url.pathname === '/api/refresh') {
		// Status must remain observable while a long-running job owns the queue.
		void Promise.all([jobs.status('subscriptions'), jobs.status('videos')])
			.then(([subscriptions, videos]) => send(200, { subscriptions, videos }),
				() => send(500, { error: 'Refresh status is unavailable.' }))
		return
	}
	if (url.pathname === '/api/activity') {
		try {
			const page = parseActivityPage(url.searchParams)
			void jobs.maintenance(randomUUID(), () => listActivity(db, page))
				.then(result => send(200, result),
					() => send(500, { error: 'Activity is unavailable.' }))
		} catch { send(400, { error: 'Invalid activity page.' }) }
		return
	}
	let query: ReturnType<typeof parseVideoQuery>
	try { query = parseVideoQuery(url.searchParams) } catch {
		send(400, { error: 'Invalid video filters.' })
		return
	}
	void jobs.maintenance(randomUUID(), async () => {
		if (url.pathname === '/api/cookies/status') {
			return { mode: actions!.config.mode,
				connection: await actions!.cookieStatus(),
				cleanupPending: await actions!.cookieCleanupPending(),
				environmentCookie: process.env.YOUTUBE_COOKIE !== undefined }
		}
		if (url.pathname === '/api/subscriptions/export') {
			if (!actions) throw new Error('Subscription export unavailable.')
			return exportSubscriptions(actions.config)
		}
		if (url.pathname === '/api/email/tests') {
			return { tests: await db.all(`SELECT id, startedAt, finishedAt, outcome
				FROM email_test_runs ORDER BY startedAt DESC, rowid DESC LIMIT 20`) }
		}
		if (url.pathname === '/api/incidents') {
			return { incidents: await db.all(`SELECT i.id, i.source, i.category,
				i.channelId, i.openedAt, i.lastObservedAt, i.resolvedAt, i.occurrences,
				i.emailState, r.state AS reminderState, c.state AS recoveryState
				FROM incidents i LEFT JOIN incident_reminders r ON r.incidentId=i.id
				LEFT JOIN incident_recovery_alerts c ON c.incidentId=i.id
				ORDER BY i.resolvedAt IS NULL DESC, i.lastObservedAt DESC
				LIMIT 100`) }
		}
		if (url.pathname === '/api/channel-events') {
			return { events: await db.all(`SELECT e.id, e.profileKey, e.channelId,
				s.channelTitle, e.previousState, e.currentState, e.observedAt
				FROM cookie_channel_events e LEFT JOIN subscriptions s
				ON s.channelId=e.channelId ORDER BY e.observedAt DESC, e.id DESC
				LIMIT 100`) }
		}
		if (url.pathname === '/api/title-events') {
			const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
				.toISOString()
			return { events: await db.all(SQL`SELECT id, channelId, previousTitle,
				currentTitle, observedAt, emailState FROM channel_title_events
				WHERE observedAt >= ${cutoff} ORDER BY observedAt DESC, id DESC
				LIMIT 100;`) }
		}
		if (url.pathname === '/api/channel-added-events') {
			return { events: await db.all(`SELECT e.channelId, e.observedAt,
				COALESCE(s.channelTitle, e.channelId) AS title, b.emailState
				FROM channel_added_events e JOIN channel_added_batches b
				ON b.id=e.batchId LEFT JOIN subscriptions s ON s.channelId=e.channelId
				ORDER BY e.observedAt DESC, e.rowid DESC LIMIT 100`) }
		}
		if (url.pathname === '/api/channels') {
			const channels = await db.all(`SELECT channelId, channelTitle,
				channelThumbnail, deleted, deletedReason, firstObservedAt, bellState,
				bellUpdatedAt, EXISTS(SELECT 1 FROM cookie_bell_actions a
				JOIN cookie_connection c ON c.channelId=a.profileKey
				WHERE a.channelId=subscriptions.channelId AND c.id=1
				AND a.state IN ('pending', 'uncertain')) AS bellUncertain
				, EXISTS(SELECT 1 FROM cookie_subscription_actions a
				JOIN cookie_connection c ON c.channelId=a.profileKey
				WHERE a.channelId=subscriptions.channelId AND c.id=1
				AND a.state IN ('pending', 'uncertain')) AS subscriptionUncertain
				, EXISTS(SELECT 1 FROM cookie_unsubscribe_undos u
				JOIN cookie_connection c ON c.channelId=u.profileKey WHERE c.id=1
				AND u.channelId=subscriptions.channelId
				AND u.state IN ('pending', 'partial')) AS undoIncomplete
				, (SELECT u.priorBell FROM cookie_unsubscribe_undos u
				JOIN cookie_connection c ON c.channelId=u.profileKey WHERE c.id=1
				AND u.channelId=subscriptions.channelId
				AND u.state IN ('pending', 'partial')
				ORDER BY u.startedAt DESC, u.rowid DESC LIMIT 1) AS undoPriorBell
				, COALESCE((SELECT a.target=0 AND a.state='confirmed'
				FROM cookie_subscription_actions a JOIN cookie_connection c
				ON c.channelId=a.profileKey WHERE c.id=1
				AND a.channelId=subscriptions.channelId
				ORDER BY a.startedAt DESC, a.rowid DESC LIMIT 1), 0) AS undoAvailable
				, EXISTS(SELECT 1 FROM cookie_channel_state s
				JOIN cookie_connection c ON c.channelId=s.profileKey
				WHERE s.channelId=subscriptions.channelId AND c.id=1
				AND s.subscribed=1) AS cookieSubscribed
				FROM subscriptions ORDER BY channelTitle, channelId`)
			const manualMode = actions?.manualMode() ?? false
			const apiMode = actions?.config.mode === 'youtube' &&
				!!actions.config.emailSelectionPolicy
			const allowed = new Set(
				actions?.config.whitelistedChannelIds?.map(c => c.id))
			const blocked = new Set(
				actions?.config.blacklistedChannelIds?.map(c => c.id))
			const manuallyTracked = new Set(
				actions?.config.manualChannelIds?.map(c => c.id))
			const manualOnly = apiMode ? new Set<string>((await db.all(`
				SELECT channelId FROM channel_sources
				WHERE manual=1 AND apiSubscribed=0`))
				.map(row => row.channelId as string)) : new Set<string>()
			const eligibility = actions
				? makeEmailEligibility(actions.config, manualOnly) : null
			return { manualMode, apiMode,
				cookieMode: actions?.config.mode === 'cookie',
				confirmUnsubscribe: actions?.config.confirmUnsubscribe !== false,
				cookieStale: !!actions?.config.cookieStale,
				channels: channels.map(channel => ({ ...channel,
					muted: actions?.config.channelSettingsById?.get(
						channel.channelId)?.notify === false,
					...(apiMode ? { allowlisted: allowed.has(channel.channelId),
						blocklisted: blocked.has(channel.channelId),
						manualTracked: manuallyTracked.has(channel.channelId),
						emailStatus: eligibility?.(channel.channelId,
							actions?.config.channelSettingsById?.get(channel.channelId)),
					} : {}),
					...(manualMode || actions?.config.mode === 'youtube' ||
						(actions?.config.mode === 'cookie' &&
						channel.cookieSubscribed)
						? { notify: actions?.channelNotify(channel.channelId) }
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
