import axios from 'axios'
import {
	generateSapisidHash, extractSapisidFromCookie, normalizeCookieHeader,
	extractChannelsFromInnerTube, fetchAccountsList, YouTubeProfile,
	ChannelBellState, BellNotificationPreference, extractBellActionParams,
} from './innertubeChannels'
import { loadConfigRaw } from '../config'
import { CookieSessionError } from './cookieSessionError'
import { discoverCookieProfiles, ResolvedCookieProfile } from './cookieProfiles'

export { CookieSessionError } from './cookieSessionError'

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/browse'
const ACCOUNT_MENU_URL =
	'https://www.youtube.com/youtubei/v1/account/account_menu'
const CLIENT_VERSION = '2.20240101.00.00'
const MAX_SUBSCRIPTION_PAGES = 1000

export interface CookieFetchOptions {
	cookie: string
	account?: string
	pageId?: string
	targetProfile?: ResolvedCookieProfile
	onProgress?: (message: string) => void
	onPage?: (data: unknown) => void
}

export const fetchAccountName = async (
	cookieHeader: string,
	sapisid: string,
	pageId?: string,
): Promise<string | null> => {
	try {
		const authHeader = generateSapisidHash(sapisid)
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Cookie': cookieHeader,
			'Authorization': authHeader,
			'X-Origin': 'https://www.youtube.com',
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
				'AppleWebKit/537.36 (KHTML, like Gecko) ' +
				'Chrome/120.0.0.0 Safari/537.36',
		}
		if (pageId) {
			headers['X-Goog-PageId'] = pageId
			headers['X-Goog-AuthUser'] = '0'
		}

		const context: Record<string, unknown> = {
			client: {
				clientName: 'WEB',
				clientVersion: CLIENT_VERSION,
			},
		}
		if (pageId) {
			context.user = { onBehalfOfUser: pageId }
		}

		const res = await axios.post(
			ACCOUNT_MENU_URL,
			{ context },
			{ headers, timeout: 10000 },
		)
		const str = JSON.stringify(res.data)
		const match = str.match(/"accountName":\{"simpleText":"([^"]+)"\}/)
		return match ? match[1] : null
	} catch {
		return null
	}
}

export const resolveTargetProfile = async (
	cookieHeader: string,
	sapisid: string,
	options: { account?: string; pageId?: string },
): Promise<{ pageId?: string; accountName: string }> => {
	let profiles: YouTubeProfile[] = []
	try {
		profiles = await fetchAccountsList(cookieHeader, sapisid)
	} catch (err) {
		if (err instanceof CookieSessionError) throw err
		// If accounts_list fails, fall back to direct options
	}

	let configAccount: string | undefined
	let configPageId: string | undefined
	try {
		const raw = await loadConfigRaw()
		const anyRaw = raw as unknown as Record<string, unknown>
		if (typeof anyRaw.youtubeAccount === 'string') {
			configAccount = anyRaw.youtubeAccount
		}
		if (typeof anyRaw.youtubePageId === 'string') {
			configPageId = anyRaw.youtubePageId
		}
	} catch {
		// config.json not yet initialized
	}

	const explicitAccount =
		options.account || process.env.YOUTUBE_ACCOUNT || configAccount
	const explicitPageId =
		options.pageId || process.env.YOUTUBE_PAGE_ID || configPageId

	if (explicitPageId) {
		const matched = profiles.find(p => p.pageId === explicitPageId)
		return {
			pageId: explicitPageId,
			accountName: matched?.accountName ?? `PageID ${explicitPageId}`,
		}
	}

	if (explicitAccount) {
		const search = explicitAccount.toLowerCase()
		const matched = profiles.find(
			p =>
				p.accountName.toLowerCase() === search ||
				p.channelHandle?.toLowerCase() === search ||
				p.accountName.toLowerCase().includes(search),
		)
		if (matched) {
			return {
				pageId: matched.pageId,
				accountName: matched.accountName,
			}
		}

		const names = profiles.map(p => `"${p.accountName}"`).join(', ')
		throw new Error(
			`Profile "${explicitAccount}" not found in session cookies.\n` +
				`Available profiles: ${names || 'None detected'}`,
		)
	}

	// Active default profile (or the one with isSelected: true)
	const selected = profiles.find(p => p.isSelected)
	if (selected) {
		if (profiles.length > 1) {
			console.log('Available accounts in session:')
			for (const p of profiles) {
				const tag = p.isSelected ? ' (active default)' : ''
				const handle = p.channelHandle ? ` (${p.channelHandle})` : ''
				console.log(`  - ${p.accountName}${handle}${tag}`)
			}
			console.log('Tip: Use --account "<name>" to select a profile.')
		}
		return {
			pageId: selected.pageId,
			accountName: selected.accountName,
		}
	}

	const fallbackName = await fetchAccountName(cookieHeader, sapisid)
	return {
		accountName: fallbackName ?? 'Unknown YouTube User',
	}
}

export const fetchCookieChannels = async (
	options: CookieFetchOptions,
): Promise<ChannelBellState[]> => {
	const cookieHeader = normalizeCookieHeader(options.cookie)
	const sapisid = extractSapisidFromCookie(cookieHeader)
	if (!sapisid) {
		throw new Error(
			'Could not find SAPISID or __Secure-3PAPISID in cookie.\n' +
				'Provide cookie as JSON array (from Cookie-Editor), ' +
				'Netscape file, or raw header.',
		)
	}

	let target: { pageId?: string, accountName: string }
	if (options.targetProfile) {
		const discovery = await discoverCookieProfiles(cookieHeader)
		const match = discovery.profiles.find(profile => profile.selectable &&
			profile.channelId === options.targetProfile?.channelId &&
			profile.pageId === options.targetProfile?.pageId)
		if (!match) throw new Error('The selected YouTube profile changed.')
		target = { pageId: match.pageId, accountName: match.name }
	} else {
		target = await resolveTargetProfile(cookieHeader, sapisid,
			{ account: options.account, pageId: options.pageId })
	}
	const { pageId, accountName } = target
	const progress = options.onProgress ?? console.log

	const pageIdTag = pageId ? ` [Brand PageId: ${pageId}]` : ''
	progress(`Connected to YouTube account: ${accountName}${pageIdTag}`)

	const observed = new Map<string, ChannelBellState>()
	const seenContinuations = new Set<string>()
	let continuationToken: string | null = null
	let page = 1

	progress('Fetching subscriptions from YouTube InnerTube API...')

	while (true) {
		if (page > MAX_SUBSCRIPTION_PAGES) {
			throw new Error('Subscription pagination limit reached; nothing saved.')
		}
		const authHeader = generateSapisidHash(sapisid)
		const payload: Record<string, unknown> = {
			context: {
				client: {
					clientName: 'WEB',
					clientVersion: CLIENT_VERSION,
					hl: 'en',
					gl: 'US',
				},
			},
		}

		if (pageId) {
			const ctx = payload.context as Record<string, unknown>
			ctx.user = { onBehalfOfUser: pageId }
		}

		if (continuationToken) {
			payload.continuation = continuationToken
		} else {
			payload.browseId = 'FEchannels'
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Cookie': cookieHeader,
			'Authorization': authHeader,
			'X-Origin': 'https://www.youtube.com',
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
				'AppleWebKit/537.36 (KHTML, like Gecko) ' +
				'Chrome/120.0.0.0 Safari/537.36',
		}

		if (pageId) {
			headers['X-Goog-PageId'] = pageId
			headers['X-Goog-AuthUser'] = '0'
		}

		let response: any
		try {
			response = await axios.post(INNERTUBE_API_URL, payload, {
				headers,
				timeout: 15000,
			})
		} catch (err: any) {
			const status = err?.response?.status
			if (status === 401 || status === 403) {
				const authErr = new CookieSessionError(
					'YouTube session cookie has expired or is invalid. ' +
						'Please update cookies.txt with a fresh session.',
				)
				throw authErr
			}
			throw err
		}

		if (response.data?.error || response.data?.responseContext
			?.mainAppWebResponseContext?.loggedOut === true) {
			throw new CookieSessionError(
				'YouTube rejected the session; update cookies.txt.')
		}
		options.onPage?.(response.data)
		const extracted = extractChannelsFromInnerTube(response.data)
		if (extracted.invalidChannels) {
			throw new Error('Subscription response contains invalid channels; ' +
				'nothing was saved.')
		}
		const bellChannels = extracted.channels.filter(c => c.isAllNotifications)
		for (const ch of extracted.channels) {
			observed.set(ch.channelId, ch)
		}

		progress(
			`  Page ${page}: extracted ${extracted.channels.length} channels ` +
				`(${bellChannels.length} with All notifications).`,
		)

		if (!extracted.continuationToken) break
		if (seenContinuations.has(extracted.continuationToken)) {
			throw new Error('Repeated continuation token; incomplete sync not saved.')
		}
		seenContinuations.add(extracted.continuationToken)
		continuationToken = extracted.continuationToken
		page++
	}
	if (observed.size === 0) {
		throw new Error('Could not verify an empty subscription response; ' +
			'nothing was saved.')
	}

	const allBellChannels = [...observed.values()]
		.filter(channel => channel.isAllNotifications)
	progress(
		`\nTotal channels with "All" notifications: ${allBellChannels.length}`,
	)
	return [...observed.values()]
}

/** Fetch a fresh, profile-bound action and reject incomplete snapshots. */
export const fetchCookieBellAction = async (options: CookieFetchOptions,
	channelId: string, preference: BellNotificationPreference,
): Promise<string> => {
	const matches = new Set<string>()
	const channels = await fetchCookieChannels({ ...options, onPage: data => {
		const token = extractBellActionParams(data, channelId, preference)
		if (token) matches.add(token)
	} })
	if (!channels.some(channel => channel.channelId === channelId) ||
			matches.size !== 1) {
		throw new Error('YouTube did not offer this bell action for the channel.')
	}
	return [...matches][0]
}
