import { isChannelId } from './channelId'
import {
	extractSapisidFromCookie, fetchAccountsList, normalizeCookieHeader,
	YouTubeProfile,
} from './innertubeChannels'
import { resolveChannelId } from './resolveChannelId'
import { CookieSessionError } from './cookieSessionError'

export interface ResolvedCookieProfile {
	name: string,
	handle?: string,
	pageId?: string,
	selected: boolean,
	channelId: string | null,
	selectable: boolean,
}

interface ProfileDependencies {
	list: (header: string, sapisid: string) => Promise<YouTubeProfile[]>,
	resolve: (handle: string) => Promise<string>,
}

/** Resolve account handles to canonical channel IDs, never matching by name. */
export const discoverCookieProfiles = async (
	raw: string,
	deps: ProfileDependencies = {
		list: fetchAccountsList, resolve: resolveChannelId,
	},
): Promise<{ cookieHeader: string, profiles: ResolvedCookieProfile[] }> => {
	if (typeof raw !== 'string' || raw.length > 256 * 1024) {
		throw new Error('Cookie input is invalid or too large.')
	}
	const cookieHeader = normalizeCookieHeader(raw)
	const sapisid = extractSapisidFromCookie(cookieHeader)
	if (!sapisid) throw new CookieSessionError('YouTube cookie is incomplete.')
	const accounts = await deps.list(cookieHeader, sapisid)
	if (!Array.isArray(accounts) || !accounts.length || accounts.length > 20 ||
			accounts.filter(account => account.isSelected).length !== 1) {
		throw new Error('YouTube account profiles could not be verified.')
	}
	const profiles: ResolvedCookieProfile[] = []
	const seen = new Set<string>()
	for (const account of accounts) {
		if (typeof account.accountName !== 'string' ||
				(account.pageId !== undefined &&
				(typeof account.pageId !== 'string' || !account.pageId ||
				account.pageId.length > 256))) {
			throw new Error('YouTube account profile is invalid.')
		}
		let channelId: string | null = null
		if (typeof account.channelHandle === 'string' &&
				/^@[^\s/?#\\]{1,100}$/u.test(account.channelHandle)) {
			try {
				const resolved = await deps.resolve(account.channelHandle)
				if (isChannelId(resolved)) channelId = resolved
			} catch { /* Profile is not selectable until identity is verified. */ }
		}
		if (channelId && seen.has(channelId)) {
			throw new Error('YouTube returned duplicate profile identities.')
		}
		if (channelId) seen.add(channelId)
		const name = [...account.accountName].filter(char => {
			const code = char.charCodeAt(0)
			return code >= 32 && code !== 127
		}).join('').slice(0, 200)
		profiles.push({ name,
			...(account.channelHandle ? { handle: account.channelHandle } : {}),
			...(account.pageId ? { pageId: account.pageId } : {}),
			selected: account.isSelected, channelId,
			selectable: !!channelId && (!!account.pageId || account.isSelected),
		})
	}
	return { cookieHeader, profiles }
}
