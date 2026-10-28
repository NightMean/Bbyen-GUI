import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CookiePreviewService } from './cookiePreview'
import { secureCookieStorage } from './secureCookieStorage'
import { oauthTokenHash, withOAuthTokenLock } from './oauthCleanup'

/** Confirm a reviewed cookie snapshot and atomically make it authoritative. */
export const activateConfirmedCookie = async (
	config: Config, store: CookieConnectionStore, previews: CookiePreviewService,
	candidateId: string, previewId: string,
	options?: { directory: string, sourceRevision: () => Promise<string>,
		recover: () => Promise<boolean>,
		verifyApiProfile?: (channelId: string) => Promise<void> },
): Promise<void> => {
	if (config.apiEnrichment) {
		throw new Error('Disable API enrichment before changing cookie profiles.')
	}
	if (await store.cleanupPending()) {
		throw new Error('Previous cookie cleanup must finish first.')
	}
	const fromApi = config.mode === 'youtube'
	if (fromApi && (!options || await store.oauthCleanupPending())) {
		throw new Error('OAuth cleanup must be available before switching.')
	}
	const candidate = await previews.confirm(candidateId, previewId)
	if (candidate.keepApi && (!fromApi || !options?.verifyApiProfile)) {
		throw new Error('Combined tracking requires an active API account.')
	}
	await secureCookieStorage(config.database.filename)
	if (options && candidate.sourceRevision !== await options.sourceRevision()) {
		throw new Error('Source changed; review the switch again.')
	}
	let activated = false
	if (fromApi && options) {
		try {
			await withOAuthTokenLock(options.directory, async () => {
				if (config.mode !== 'youtube' ||
						candidate.sourceRevision !== await options.sourceRevision()) {
					throw new Error('Source changed; review the switch again.')
				}
				if (candidate.keepApi) {
					await options.verifyApiProfile!(candidate.profile.channelId!)
					if (candidate.sourceRevision !== await options.sourceRevision()) {
						throw new Error('Source changed; review the switch again.')
					}
				}
				const hash = await oauthTokenHash(options.directory)
				await store.activate(candidate.cookieHeader, candidate.profile,
					candidate.channels, candidate.keepApi ? undefined : hash ?? undefined,
					candidate.keepApi ? candidate.profile.channelId! : undefined)
				activated = true
			})
		} catch (error) {
			if (!activated) throw error
			// The database committed; deferred cleanup reports any remaining file.
		}
	} else {
		if (config.mode !== 'whitelist' && config.mode !== 'cookie') {
			throw new Error('Source changed; review the switch again.')
		}
		await store.activate(candidate.cookieHeader, candidate.profile,
			candidate.channels)
	}
	config.mode = 'cookie'
	config.apiEnrichment = candidate.keepApi
	config.cookieStale = candidate.channels.some(channel =>
		channel.notificationState === 'unknown')
	if (fromApi && options && !candidate.keepApi) {
		try { await options.recover() } catch {
			// The durable cleanup record will be retried and shown in Settings.
		}
	}
}
