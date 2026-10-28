import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { isChannelId } from '../lib/channelId'

/** Resolve the account's canonical channel, never a display name or page ID. */
export const readAccountIdentity = async (
	service: youtube_v3.Youtube, auth: OAuth2Client,
): Promise<{ channelId: string, title: string }> => {
	const response = await service.channels.list({
		auth, mine: true, part: ['id', 'snippet'], maxResults: 2,
	})
	const items = response.data.items
	if (!Array.isArray(items) || items.length !== 1 ||
			response.data.nextPageToken || !items[0].id ||
			!isChannelId(items[0].id)) {
		throw new Error('YouTube account identity could not be verified.')
	}
	const title = items[0].snippet?.title
	return { channelId: items[0].id,
		title: typeof title === 'string' ? title.slice(0, 200) : '' }
}

export const sameAccount = (
	apiChannelId: string, cookieChannelId: string | null | undefined,
): boolean => isChannelId(apiChannelId) &&
	!!cookieChannelId && isChannelId(cookieChannelId) &&
	apiChannelId === cookieChannelId
