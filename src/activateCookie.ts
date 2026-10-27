import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CookiePreviewService } from './cookiePreview'
import { secureCookieStorage } from './secureCookieStorage'

/** Confirm a reviewed cookie snapshot and atomically make it authoritative. */
export const activateConfirmedCookie = async (
	config: Config, store: CookieConnectionStore, previews: CookiePreviewService,
	candidateId: string, previewId: string,
): Promise<void> => {
	if (config.mode === 'youtube') {
		throw new Error('API-to-cookie switching is unavailable.')
	}
	const candidate = await previews.confirm(candidateId, previewId)
	await secureCookieStorage(config.database.filename)
	await store.activate(candidate.cookieHeader, candidate.profile,
		candidate.channels)
	config.mode = 'cookie'
	config.cookieStale = candidate.channels.some(channel =>
		channel.notificationState === 'unknown')
}
