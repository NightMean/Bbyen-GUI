import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { CookieConnectionStore } from './cookieConnection'
import { readAccountIdentity, sameAccount } from './google/accountIdentity'
import { withAuthorizationTimeout } from './google/desktopAuthorization'

/** Compare stable account IDs while guarding both credential generations. */
export const compareConnectionIdentities = async (options: {
	store: CookieConnectionStore,
	service: youtube_v3.Youtube,
	loadAuth: () => Promise<OAuth2Client>,
	authRevision: () => Promise<string>,
}) => {
	const before = await options.store.read()
	if (!before) throw new Error('Cookie connection is unavailable.')
	const revision = await options.authRevision()
	const auth = await options.loadAuth()
	const identity = await withAuthorizationTimeout(
		readAccountIdentity(options.service, auth))
	const after = await options.store.read()
	if (!after || before.generation !== after.generation ||
			revision !== await options.authRevision()) {
		throw new Error('Connections changed during identity verification.')
	}
	return { matches: sameAccount(identity.channelId, before.profile.channelId),
		api: identity, cookie: { channelId: before.profile.channelId,
			name: before.profile.name } }
}
