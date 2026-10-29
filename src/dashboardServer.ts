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
	ImportChangedError, ImportConfirmationError, ImportRecoveryError,
	SubscriptionImportService,
} from './subscriptionImportService'
import { parseRefreshIntervals, RefreshIntervals } from './refreshSchedule'
import {
	GeneralSettings, parseGeneralSettings, readGeneralSettings,
} from './generalSettings'
import { CookiePreviewService } from './cookiePreview'
import { ManualSourceSwitch } from './manualSourceSwitch'
import { CookieBellActions } from './cookieBellActions'
import { CookieSubscriptionActions } from './cookieSubscriptionActions'
import { ApiSubscriptionActions } from './apiSubscriptionActions'
import { BellNotificationPreference } from './lib/innertubeChannels'
import { ApiChannelList } from './apiChannelLists'
import { makeEmailEligibility, parseEmailSelectionPolicy } from './emailPolicy'
import { RemoteDesktopAuth } from './remoteDesktopAuth'
import { CombinedMode } from './combinedMode'
import { ApiSourceSwitch, IncompleteApiSnapshot, UnconfirmedCookieSnapshot }
	from './apiSourceSwitch'
import { ApiManualSwitch } from './apiManualSwitch'
import { ManualApiSwitch } from './manualApiSwitch'
import { channelAddPreview, readPublicChannelTitle } from './channelAddPreview'
import { readBuildIdentity } from './buildIdentity'
import { ApiPolicyPreview, PolicyPreviewError } from './apiPolicyPreview'

interface ChannelActions {
	add: (channelId: string, initialBacklog?: BacklogPolicy) => Promise<void>,
	resolve: (input: string) => Promise<string>,
	refresh: (kind: RefreshKind) => void,
	setNotify: (channelId: string, notify: boolean) => Promise<void>,
	setCookieBacklog: (channelId: string, policy: BacklogPolicy) => Promise<void>,
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
	oauthCleanupPending?: () => Promise<boolean>,
	compareIdentities?: () => Promise<unknown>,
	remoteDesktopAuth?: RemoteDesktopAuth,
	combinedMode?: CombinedMode,
	apiSourceSwitch?: ApiSourceSwitch,
	apiManualSwitch?: ApiManualSwitch,
	manualApiSwitch?: ManualApiSwitch,
	apiPolicyPreview?: ApiPolicyPreview,
	verifyApiProfile?: (channelId: string) => Promise<void>,
	bellActions: CookieBellActions,
	subscriptionActions: CookieSubscriptionActions,
	apiSubscriptionActions?: ApiSubscriptionActions,
}

type SubscriptionResult = string | { outcome: string, bell?: string | null }

/** Dashboard API. Database work shares the refresh queue. */
export const createDashboardHandler = (
	db: sqlite.Database, jobs: RefreshCoordinator, actions?: ChannelActions,
): RequestListener => (request, response) => {
	response.setHeader('Content-Type', 'application/json; charset=utf-8')
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('X-Content-Type-Options', 'nosniff')
	let url: URL
	const send = (status: number, value: unknown) => {
		if (status >= 500 && value && typeof value === 'object') {
			const reference = randomUUID()
			value = { ...value, reference }
			try {
				console.error(`${new Date().toISOString()} [error] [dashboard] ` +
					`${request.method} ${url.pathname} ${status} reference=${reference}`)
			} catch { /* Logging must not prevent the response. */ }
		}
		response.writeHead(status)
		response.end(JSON.stringify(value))
	}
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
			url.pathname === '/api/email/policy/preview' ||
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
			url.pathname === '/api/cookies/compare-identity' ||
			url.pathname === '/api/oauth/desktop/start' ||
			url.pathname === '/api/oauth/desktop/finish' ||
			url.pathname === '/api/combined/preview' ||
			url.pathname === '/api/combined/apply' ||
			url.pathname === '/api/source/api/preview' ||
			url.pathname === '/api/source/api/apply' ||
			url.pathname === '/api/source/manual/preview' ||
			url.pathname === '/api/source/manual/apply' ||
			url.pathname === '/api/source/from-manual/preview' ||
			url.pathname === '/api/source/from-manual/apply' ||
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
		if (actions.config.manualTransitionPending) {
			send(503, { error: 'A confirmed source switch is recovering. ' +
				'Please wait for recovery or check the service log.' })
			return
		}
		const writeMaintenance = <T>(work: () => Promise<T>): Promise<T> =>
			jobs.maintenance(randomUUID(), () => {
				if (actions.config.manualTransitionPending) {
					throw new Error('Source transition is recovering.')
				}
				return work()
			})
		const recordConfigurationActivity = async (
			kind: 'import' | 'removal', channelId: string | null = null,
		): Promise<void> => {
			try {
				await db.run(SQL`INSERT INTO configuration_activity
					(kind, channelId, observedAt)
					VALUES (${kind}, ${channelId}, ${new Date().toISOString()});`)
			} catch {
				// A diagnostic failure must not mask a completed configuration write.
				console.warn('Could not record channel configuration activity.')
			}
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
				confirmUnsubscribe?: unknown, list?: unknown, included?: unknown,
				port?: unknown, id?: unknown, state?: unknown, code?: unknown,
				direction?: unknown, keepApi?: unknown, policy?: unknown } = {}
			try {
				const parsed: unknown = JSON.parse(body)
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error('Expected an object.')
				}
				data = parsed
			} catch { send(400, { error: 'Expected a JSON object.' }); return }
			if (url.pathname.startsWith('/api/source/from-manual/')) {
				const source = actions.manualApiSwitch
				if (!source) {
					send(503, { error: 'API source switch is unavailable.' }); return
				}
				const preview = data.previewId
				if (url.pathname.endsWith('/apply') &&
						(typeof preview !== 'string' || !preview)) {
					send(400, { error: 'Source preview is missing.' }); return
				}
				void writeMaintenance(async () =>
					url.pathname.endsWith('/preview') ? source.review() :
						source.apply(preview as string)).then(result => send(200, result),
					() => send(409, { error: 'Could not verify the Google account ' +
						'or its subscriptions. Connect Google and review again.' }))
				return
			}
			if (url.pathname.startsWith('/api/source/manual/')) {
				const source = actions.apiManualSwitch
				if (!source) {
					send(503, { error: 'Manual source switch is unavailable.' }); return
				}
				const preview = data.previewId
				if (url.pathname.endsWith('/apply') &&
						(typeof preview !== 'string' || !preview)) {
					send(400, { error: 'Source preview is missing.' }); return
				}
				void writeMaintenance(async () =>
					url.pathname.endsWith('/preview') ? source.review() :
						source.apply(preview as string)).then(result => send(200, result),
					() => send(409, { error: 'Could not verify the manual switch. ' +
						'Review the current connection again.' }))
				return
			}
			if (url.pathname.startsWith('/api/source/api/')) {
				const source = actions.apiSourceSwitch
				if (!source) {
					send(503, { error: 'API source switch is unavailable.' }); return
				}
				const preview = data.previewId
				if (url.pathname.endsWith('/apply') &&
						(typeof preview !== 'string' || !preview)) {
					send(400, { error: 'Source preview is missing.' }); return
				}
				void writeMaintenance(async () =>
					url.pathname.endsWith('/preview') ? source.review() :
						source.apply(preview as string)).then(result => {
					send(200, result)
					if (url.pathname.endsWith('/apply')) actions.refresh('videos')
				}, error => send(409, { error:
					error instanceof UnconfirmedCookieSnapshot
						? 'Cookie data is unconfirmed. Refresh the cookie connection first.'
						: error instanceof IncompleteApiSnapshot
							? 'YouTube API omitted subscriptions confirmed by the cookie. ' +
						'Cookie tracking remains active; retry later.'
							: 'Could not verify the source switch. Check the Google ' +
								'account and review again.' }))
				return
			}
			if (url.pathname.startsWith('/api/combined/')) {
				const mode = actions.combinedMode
				if (!mode) {
					send(503, { error: 'Combined mode unavailable.' }); return
				}
				const direction = data.direction, preview = data.previewId
				if (url.pathname.endsWith('/preview') && direction !== 'enable' &&
						direction !== 'disable') {
					send(400, { error: 'Choose a connection change.' }); return
				}
				if (url.pathname.endsWith('/apply') &&
						(typeof preview !== 'string' || !preview)) {
					send(400, { error: 'Connection preview is missing.' }); return
				}
				void writeMaintenance(async () =>
					url.pathname.endsWith('/preview')
						? mode.review(direction as 'enable' | 'disable')
						: mode.apply(preview as string)).then(result => {
					if (url.pathname.endsWith('/apply')) actions.refresh('subscriptions')
					send(200, result)
				},
				() => send(409, { error: 'Could not verify the connection change. ' +
						'Check both profiles and review again.' }))
				return
			}
			if (url.pathname.startsWith('/api/oauth/desktop/')) {
				if (!actions.remoteDesktopAuth) {
					send(503, { error: 'Google authorization is unavailable.' }); return
				}
				const remote = actions.remoteDesktopAuth
				const work = async (): Promise<unknown> => {
					if (url.pathname.endsWith('/start')) return remote.start(data.port)
					await remote.finish(data.id, data.state, data.code)
					return { authorized: true }
				}
				void writeMaintenance(work).then(
					result => send(200, result),
					() => send(422, { error: 'Google authorization failed. Check the ' +
						'client and selected YouTube profile, then try again.' }))
				return
			}
			if (url.pathname.startsWith('/api/cookies/')) {
				if (url.pathname === '/api/cookies/compare-identity') {
					if (!actions.compareIdentities || actions.config.mode !== 'cookie') {
						send(409, { error: 'A cookie connection is required.' }); return
					}
					void writeMaintenance(() =>
						actions.compareIdentities!()).then(result => send(200, result),
						() => send(422, { error: 'Could not verify both connections.' }))
					return
				}
				if (url.pathname === '/api/cookies/manual/preview') {
					void writeMaintenance(() =>
						actions.manualSwitch.preview()).then(result => send(200, result),
						() => send(409, { error: 'Could not preview the source switch.' }))
					return
				}
				if (url.pathname === '/api/cookies/manual/apply') {
					if (typeof data.previewId !== 'string' || !data.previewId) {
						send(400, { error: 'Source switch preview is missing.' }); return
					}
					const preview = data.previewId
					void writeMaintenance(() =>
						actions.manualSwitch.apply(preview)).then(result =>
						send(200, { switched: true, ...result }), () => send(409, {
						error: 'Could not confirm the switch. Review the preview again.',
					}))
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
					if (data.keepApi !== undefined && typeof data.keepApi !== 'boolean') {
						send(400, { error: 'Choose whether to keep API access.' }); return
					}
					if (data.keepApi && (actions.config.mode !== 'youtube' ||
							!actions.verifyApiProfile)) {
						send(409, { error: 'API tracking is unavailable.' }); return
					}
					const verify = data.keepApi ? actions.verifyApiProfile : undefined
					void writeMaintenance(() =>
						actions.cookiePreviews.compare(candidate, profile, verify)).then(
						result => send(200, result), () => send(422, {
							error: 'Could not compare channels for this profile.',
						}))
					return
				}
				if (typeof data.previewId !== 'string' || !data.previewId) {
					send(400, { error: 'Cookie comparison is missing.' }); return
				}
				const preview = data.previewId
				void writeMaintenance(async () => {
					await actions.activateCookie(candidate, preview)
					return { mode: actions.config.mode,
						apiEnrichment: !!actions.config.apiEnrichment,
						connection: await actions.cookieStatus(),
						cleanupPending: await actions.cookieCleanupPending(),
						oauthCleanupPending: await actions.oauthCleanupPending?.() ?? false,
						environmentCookie: process.env.YOUTUBE_COOKIE !== undefined }
				}).then(connection => {
					send(200, { connected: true, connection })
					if (actions.config.apiEnrichment) actions.refresh('subscriptions')
					actions.refresh('videos')
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
				void writeMaintenance(() =>
					actions.saveUnsubscribePreference(enabled)).then(() =>
					send(200, { confirmUnsubscribe: enabled }), () => send(500, {
					error: 'Could not confirm the saved setting.',
				}))
				return
			}
			if (url.pathname === '/api/email/policy/preview') {
				let policy: ReturnType<typeof parseEmailSelectionPolicy>
				try { policy = parseEmailSelectionPolicy(data.policy) } catch {
					send(400, { error: 'Choose a valid email policy.' }); return
				}
				if (!actions.apiPolicyPreview) {
					send(503, { error: 'Email policy review is unavailable.' }); return
				}
				void writeMaintenance(() => actions.apiPolicyPreview!.review(policy))
					.then(result => send(200, result), () => send(409, {
						error: 'Could not review the current email policy.',
					}))
				return
			}
			if (url.pathname === '/api/settings') {
				try { parseGeneralSettings(data.settings) } catch {
					send(400, { error: 'Enter valid settings.' }); return
				}
				void writeMaintenance(async () => {
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
					if (changedPolicy && actions.config.mode === 'youtube') {
						if (!actions.apiPolicyPreview || !settings.emailSelectionPolicy) {
							throw new PolicyPreviewError('Policy review is required.')
						}
						await actions.apiPolicyPreview.confirm(data.previewId,
							settings.emailSelectionPolicy)
					}
					await actions.saveGeneral(settings)
					return { settings, changedPolicy }
				})
					.then(({ settings, changedPolicy }) => {
						if (changedPolicy && actions.config.mode === 'youtube') {
							actions.refresh('subscriptions')
						}
						send(200, { settings })
					}, error => send(error instanceof PolicyPreviewError ? 409 : 500, {
						error: error instanceof PolicyPreviewError ?
							'Policy review changed or expired. Review again.' :
							'Could not confirm settings. Reload before retrying.',
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
				void writeMaintenance(() =>
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
				void writeMaintenance(() =>
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
				void writeMaintenance(async () => {
					await actions.imports.apply(id, choice, data.acceptPartial as boolean)
					await recordConfigurationActivity('import')
				})
					.then(() => {
						actions.refresh('subscriptions'); send(200, { applied: true })
					}, err => {
						if (err instanceof ImportRecoveryError) {
							actions.refresh('subscriptions')
							send(500, { error: 'Import outcome needs review.',
								recoveryRequired: true })
							return
						}
						const status = err instanceof ImportChangedError ? 409 :
							err instanceof ImportConfirmationError ? 400 : 500
						send(status, { error: 'Import failed. Review the preview again.' })
					})
				return
			}
			if (url.pathname === '/api/email/test') {
				void writeMaintenance(actions.testEmail).then(
					outcome => send(200, { outcome }),
					() => send(500, { error: 'Could not confirm the test outcome.' }))
				return
			}
			if (url.pathname === '/api/email/settings') {
				let settings: PublicEmailSettings
				try { settings = parseEmailSettings(data.settings) } catch {
					send(400, { error: 'Enter valid email settings.' }); return
				}
				void writeMaintenance(() => actions.saveEmail(settings))
					.then(() => send(200, { saved: true }),
						() => send(500, { error: 'Could not save email settings.' }))
				return
			}
			if (url.pathname === '/api/email/credentials') {
				try { parseEmailCredentials(data.credentials) } catch {
					send(400, { error: 'Check credentials and environment settings.' })
					return
				}
				void writeMaintenance(() =>
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
				void actions.resolve(data.input).then(async channelId => {
					if (!isChannelId(channelId)) {
						send(422, { error: 'Could not resolve this YouTube address.' })
						return
					}
					const preview = await jobs.maintenance(randomUUID(), () =>
						channelAddPreview(db, actions.config, channelId))
					preview.title ??= await readPublicChannelTitle(channelId)
					send(200, preview)
				}).catch(() => send(422, {
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
				void writeMaintenance(() =>
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
				void writeMaintenance(() =>
					actions.setNotify(id, data.notify as boolean)).then(() =>
					send(200, { channelId: id, notify: data.notify }),
				() => send(500, { error: 'Could not save notification setting.' }))
				return
			}
			if (url.pathname === '/api/channels/bell/review') {
				void writeMaintenance(() =>
					actions.bellActions.review(id))
					.then(result => send(200, result), () => send(409, {
						error: 'Could not verify the account and bell state.',
					}))
				return
			}
			if (url.pathname === '/api/channels/subscription/undo/acknowledge') {
				void writeMaintenance(() =>
					actions.subscriptionActions.acknowledgeUndo(id)).then(() =>
					send(200, { acknowledged: true }), () => send(409, {
					error: 'Review unresolved YouTube requests first.',
				}))
				return
			}
			if (url.pathname === '/api/channels/subscription/undo') {
				void writeMaintenance(() =>
					actions.config.mode === 'youtube' && actions.apiSubscriptionActions
						? actions.apiSubscriptionActions.undo(id).then(subscription =>
							({ subscription, bell: 'unavailable' }))
						: actions.subscriptionActions.undo(id, (channelId, preference) =>
							actions.bellActions.change(channelId, preference, true)))
					.then(outcome => {
						if (actions.config.mode === 'youtube') {
							actions.refresh('subscriptions')
						}
						send(200, outcome)
					}, () => send(409, {
						error: 'Could not undo the YouTube unsubscribe.',
					}))
				return
			}
			if (url.pathname === '/api/channels/subscription/review') {
				void writeMaintenance(() =>
					actions.config.mode === 'youtube' && actions.apiSubscriptionActions
						? actions.apiSubscriptionActions.review(id)
						: actions.subscriptionActions.review(id)).then(result =>
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
				let cookieBacklog: BacklogPolicy | undefined
				try {
					if (data.initialBacklog !== undefined && data.profileId) {
						cookieBacklog = parseBacklogPolicy(data.initialBacklog,
							'initialBacklog')
					} else if (data.initialBacklog !== undefined) {
						throw new Error('Profile required.')
					}
				} catch {
					send(400, { error: 'Invalid initial video preference.' }); return
				}
				if ((data.profileId !== undefined &&
						(!subscribed || typeof data.profileId !== 'string' ||
						!isChannelId(data.profileId))) ||
						(data.preference !== undefined &&
						(data.preference !== 'all' || !subscribed ||
						!data.profileId))) {
					send(400, { error: 'Invalid account or bell action.' }); return
				}
				if (url.pathname.endsWith('/acknowledge')) {
					void writeMaintenance(() =>
						actions.config.mode === 'youtube' && actions.apiSubscriptionActions
							? actions.apiSubscriptionActions.acknowledge(id, subscribed)
							: actions.subscriptionActions.acknowledge(id, subscribed))
						.then(() => {
							if (actions.config.mode === 'youtube') {
								actions.refresh('subscriptions')
							}
							send(200, { acknowledged: true })
						}, () => send(409, {
							error: 'Could not verify the account and subscription.',
						}))
					return
				}
				void writeMaintenance<SubscriptionResult>(
					() => {
						if (actions.config.mode === 'youtube') {
							if (!actions.apiSubscriptionActions || subscribed) {
								throw new Error('API subscription action is unavailable.')
							}
							return actions.apiSubscriptionActions.unsubscribe(id)
						}
						if (data.profileId !== undefined) {
							return (async () => {
								const profile = await actions.cookieStatus() as
								{ channelId?: string } | null
								if (actions.config.mode !== 'cookie' ||
									profile?.channelId !== data.profileId) {
									throw new Error('YouTube profile changed.')
								}
								if (cookieBacklog) {
									await actions.setCookieBacklog(id, cookieBacklog)
								}
								const outcome = await actions.subscriptionActions
									.change(id, true)
								if (data.preference !== 'all') return { outcome }
								if (outcome === 'uncertain') return { outcome, bell: null }
								let bell: string
								try { bell = await actions.bellActions.change(id, 'all') }
								catch { bell = 'unavailable' }
								return { outcome, bell }
							})()
						}
						return actions.subscriptionActions.change(id, subscribed)
					}).then(outcome => {
					if (actions.config.mode === 'youtube') {
						actions.refresh('subscriptions')
					}
					send(200, typeof outcome === 'string' ? { outcome } : outcome)
				}, () => send(409, {
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
					void writeMaintenance(() =>
						actions.bellActions.acknowledge(id, preference)).then(() =>
						send(200, { acknowledged: true }), () => send(409, {
						error: 'Could not verify the account and bell state.',
					}))
					return
				}
				void writeMaintenance(() =>
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
				void writeMaintenance(async () => {
					await actions.remove(id)
					await recordConfigurationActivity('removal', id)
				})
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
			void writeMaintenance(async () => {
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
				'/api/youtube-actions',
				'/api/refresh', '/api/incidents', '/api/email/settings',
				'/api/email/tests', '/api/subscriptions/export', '/api/schedule',
				'/api/settings', '/api/cookies/status', '/api/channel-events',
				'/api/title-events', '/api/channel-added-events', '/api/activity']
				.includes(url.pathname)) {
		send(404, { error: 'Not found.' })
		return
	}
	if (url.pathname === '/api/health') {
		send(200, { status: 'running', ...readBuildIdentity() })
		return
	}
	if (url.pathname === '/api/youtube-actions') {
		if (!actions?.apiSubscriptionActions || actions.config.mode !== 'youtube') {
			send(200, { available: false, canManage: false, channels: [] }); return
		}
		void jobs.maintenance(randomUUID(), async () => {
			const status = await actions.apiSubscriptionActions!.status()
			const channels = await db.all(`SELECT s.channelId, s.apiSubscribed,
				EXISTS(SELECT 1 FROM api_subscription_actions a
				WHERE a.profileKey=? AND a.channelId=s.channelId
				AND a.state IN ('pending', 'uncertain')) AS uncertain,
				COALESCE((SELECT a.target=0 AND a.state='confirmed'
				FROM api_subscription_actions a
				WHERE a.profileKey=? AND a.channelId=s.channelId
				ORDER BY a.startedAt DESC, a.rowid DESC LIMIT 1), 0) AS undoAvailable
				FROM channel_sources s`, status.profileKey, status.profileKey)
			return { available: true, canManage: status.canManage, channels }
		}).then(result => send(200, result), () => send(200, {
			available: false, canManage: false, channels: [],
		}))
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
				apiProfile: actions!.config.mode === 'youtube' ?
					await db.get('SELECT channelId, title FROM api_account_identity ' +
						'WHERE id=1') ?? null : null,
				manualTransitionPending: !!actions!.config.manualTransitionPending,
				apiEnrichment: !!actions!.config.apiEnrichment,
				connection: await actions!.cookieStatus(),
				cleanupPending: await actions!.cookieCleanupPending(),
				oauthCleanupPending: await actions!.oauthCleanupPending?.() ?? false,
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
			return { failedAlertCount: (await db.get(`SELECT COUNT(*) AS count
				FROM incidents i LEFT JOIN incident_reminders r ON r.incidentId=i.id
				LEFT JOIN incident_recovery_alerts c ON c.incidentId=i.id
				WHERE i.emailState IN ('failed', 'exhausted')
				OR r.state IN ('failed', 'exhausted')
				OR c.state IN ('failed', 'exhausted')`)).count,
			incidents: await db.all(`SELECT i.id, i.source, i.category,
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
				(SELECT MAX(v.publishedAt) FROM video_observations v
				WHERE v.channelId=subscriptions.channelId) AS latestPublishedAt,
				bellUpdatedAt, (SELECT m.subscribedAt
				FROM combined_subscription_metadata m JOIN combined_connection c
				ON c.profileKey=m.profileKey AND c.id=1
				WHERE m.channelId=subscriptions.channelId) AS combinedSubscribedAt,
				(SELECT s.apiSubscribedAt FROM channel_sources s
				WHERE s.channelId=subscriptions.channelId AND s.apiSubscribed=1)
				AS sourceSubscribedAt,
				EXISTS(SELECT 1 FROM cookie_bell_actions a
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
				apiEnrichment: !!actions?.config.apiEnrichment,
				confirmUnsubscribe: actions?.config.confirmUnsubscribe !== false,
				cookieStale: !!actions?.config.cookieStale,
				channels: channels.map(({ combinedSubscribedAt, sourceSubscribedAt,
					...channel }) => ({ ...channel,
					apiSubscribedAt: apiMode ? sourceSubscribedAt :
						(actions?.config.apiEnrichment ? combinedSubscribedAt : null),
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
