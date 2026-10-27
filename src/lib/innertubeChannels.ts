import crypto from 'crypto'
import axios from 'axios'
import { assertChannelId, isChannelId } from './channelId'
import { CookieSessionError } from './cookieSessionError'

export interface ChannelBellState {
	channelId: string
	title: string
	isAllNotifications: boolean
	notificationState: 'all' | 'personalized' | 'none' | 'unknown'
}

export interface YouTubeProfile {
	accountName: string
	channelHandle?: string
	pageId?: string
	isSelected: boolean
}

const ACCOUNTS_LIST_URL =
	'https://www.youtube.com/youtubei/v1/account/accounts_list'
const SUBSCRIBE_URL =
	'https://www.youtube.com/youtubei/v1/subscription/subscribe'
const UNSUBSCRIBE_URL =
	'https://www.youtube.com/youtubei/v1/subscription/unsubscribe'
const MODIFY_CHANNEL_PREFERENCE_URL =
	'https://www.youtube.com/youtubei/v1/notification/modify_channel_preference'
const CLIENT_VERSION = '2.20240101.00.00'

export type BellNotificationPreference = 'all' | 'personalized' | 'none'
const BELL_PREFERENCES: Record<BellNotificationPreference, number> = {
	personalized: 1, all: 2, none: 3,
}

const youtubeCookieDomain = (domain: unknown): boolean => {
	if (domain === undefined) return true
	if (typeof domain !== 'string') return false
	return ['youtube.com', 'www.youtube.com']
		.includes(domain.toLowerCase().replace(/^\./, ''))
}

const youtubeCookiePath = (cookiePath: unknown): boolean => {
	if (cookiePath === undefined) return true
	if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/')) {
		return false
	}
	return cookiePath === '/' || '/youtubei/v1/browse'.startsWith(
		cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)
}

const cookiePair = (name: unknown, value: unknown): string | null => {
	if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
			typeof value !== 'string' || /[;\r\n\0]/.test(value)) return null
	return `${name}=${value}`
}

/**
 * Normalizes cookies from any format (JSON array from browser extensions,
 * Netscape cookies.txt, or raw header string) into a standard Cookie header.
 */
export const normalizeCookieHeader = (rawCookie: string): string => {
	const trimmed = rawCookie.trim()
	if (!trimmed) return ''

	// 1. JSON array format (e.g. from Cookie-Editor / EditThisCookie)
	if (trimmed.startsWith('[')) {
		let parsed: unknown
		try { parsed = JSON.parse(trimmed) } catch {
			throw new Error('Cookie JSON is invalid.')
		}
		if (!Array.isArray(parsed)) throw new Error('Cookie JSON must be an array.')
		return parsed.flatMap(c => {
			if (!c || typeof c !== 'object' || !youtubeCookieDomain(c.domain) ||
					!youtubeCookiePath(c.path)) return []
			const pair = cookiePair(c.name, c.value)
			return pair ? [pair] : []
		}).join('; ')
	}

	// 2. Netscape cookies.txt format
	if (trimmed.includes('\t') && !trimmed.includes(';')) {
		const pairs: string[] = []
		for (const line of trimmed.split('\n')) {
			const clean = line.trim().replace(/^#HttpOnly_/, '')
			if (!clean || clean.startsWith('#')) continue
			const parts = clean.split('\t')
			if (parts.length >= 7 && youtubeCookieDomain(parts[0]) &&
					youtubeCookiePath(parts[2])) {
				const pair = cookiePair(parts[5], parts[6])
				if (pair) pairs.push(pair)
			}
		}
		return pairs.join('; ')
	}

	if (/[\r\n\0]/.test(trimmed)) throw new Error('Cookie header is invalid.')
	return trimmed
}

/**
 * Extracts the SAPISID cookie value from any cookie input format.
 */
export const extractSapisidFromCookie = (
	rawCookie: string,
): string | null => {
	const normalized = normalizeCookieHeader(rawCookie)
	const match = normalized.match(
		/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/,
	)
	return match ? match[1] : null
}

/**
 * Generates the SAPISIDHASH Authorization token required by YouTube's
 * internal InnerTube API for authenticated user requests.
 */
export const generateSapisidHash = (
	sapisid: string,
	origin = 'https://www.youtube.com',
	timestamp = Math.floor(Date.now() / 1000),
): string => {
	const message = `${timestamp} ${sapisid} ${origin}`
	const digest = crypto.createHash('sha1').update(message).digest('hex')
	return `SAPISIDHASH ${timestamp}_${digest}`
}

/**
 * Inspects a channelRenderer from InnerTube and determines if the channel
 * has notification bell set to "All", "Personalized", or "None".
 */
export const parseChannelRenderer = (
	channelRenderer: any,
): ChannelBellState | null => {
	if (!channelRenderer?.channelId) {
		return null
	}

	const channelId = channelRenderer.channelId
	const title =
		channelRenderer.title?.simpleText ??
		channelRenderer.title?.runs?.[0]?.text ??
		channelId

	const bellRenderer =
		channelRenderer.subscribeButton?.subscribeButtonRenderer
			?.notificationPreferenceButton
			?.subscriptionNotificationToggleButtonRenderer ??
		channelRenderer.subscriptionButton
			?.subscriptionNotificationToggleButtonRenderer ??
		channelRenderer.subscriptionButton
			?.subscriptionNotificationToggleButtonRendererNext ??
		channelRenderer.notificationPreferenceButton
			?.subscriptionNotificationToggleButtonRenderer

	if (!bellRenderer) {
		return {
			channelId,
			title,
			isAllNotifications: false,
			notificationState: 'unknown',
		}
	}

	const currentStateId = bellRenderer.currentStateId
	const states = bellRenderer.states ?? []
	const activeState = states.find(
		(s: any) => s.stateId === currentStateId,
	)?.state?.buttonRenderer

	const iconType = activeState?.icon?.iconType ?? ''
	const label = (
		activeState?.accessibility?.label ??
		activeState?.accessibility?.accessibilityData?.label ??
		activeState?.accessibilityData?.accessibilityData?.label ??
		''
	).toLowerCase()

	let notificationState: 'all' | 'personalized' | 'none' | 'unknown' =
		'unknown'

	if (
		iconType === 'NOTIFICATIONS_ACTIVE' ||
		label.includes('all notification') ||
		label.includes('všetky upozornen')
	) {
		notificationState = 'all'
	} else if (
		iconType === 'NOTIFICATIONS_NONE' ||
		label.includes('personalized') ||
		label.includes('prispôsoben')
	) {
		notificationState = 'personalized'
	} else if (
		iconType === 'NOTIFICATIONS_OFF' ||
		label.includes('no notification') ||
		label.includes('žiadne upozornen')
	) {
		notificationState = 'none'
	} else if (currentStateId === 1) {
		notificationState = 'all'
	} else if (currentStateId === 2) {
		notificationState = 'personalized'
	} else if (currentStateId === 3 || currentStateId === 0) {
		notificationState = 'none'
	}

	return {
		channelId,
		title,
		isAllNotifications: notificationState === 'all',
		notificationState,
	}
}

/**
 * Recursively searches any nested InnerTube response payload for
 * channelRenderer objects and continuation tokens.
 */
export const extractChannelsFromInnerTube = (
	data: any,
): {
	channels: ChannelBellState[]
	continuationToken: string | null
	invalidChannels: number
} => {
	const channels: ChannelBellState[] = []
	const seenIds = new Set<string>()
	let continuationToken: string | null = null
	let invalidChannels = 0

	const walk = (node: any) => {
		if (!node || typeof node !== 'object') return

		if (node.channelRenderer) {
			const parsed = parseChannelRenderer(node.channelRenderer)
			if (!parsed || !isChannelId(parsed.channelId)) invalidChannels++
			if (parsed && !seenIds.has(parsed.channelId)) {
				seenIds.add(parsed.channelId)
				channels.push(parsed)
			}
		}

		if (node.continuationCommand?.token) {
			continuationToken = node.continuationCommand.token
		} else if (node.continuationEndpoint?.continuationCommand?.token) {
			continuationToken =
				node.continuationEndpoint.continuationCommand.token
		}

		for (const key of Object.keys(node)) {
			walk(node[key])
		}
	}

	walk(data)
	return { channels, continuationToken, invalidChannels }
}

/**
 * Parses the accounts_list response to extract all profiles (personal
 * and brand channels).
 */
export const parseAccountsListResponse = (data: any): YouTubeProfile[] => {
	const profiles: YouTubeProfile[] = []
	const walk = (node: any) => {
		if (!node || typeof node !== 'object') return

		if (node.accountItem) {
			const item = node.accountItem
			const accountName =
				item.accountName?.simpleText ??
				item.accountName?.runs?.[0]?.text ??
				''
			const channelHandle =
				item.channelHandle?.simpleText ??
				item.channelHandle?.runs?.[0]?.text
			const isSelected = Boolean(item.isSelected)

			let pageId: string | undefined
			const tokens =
				item.serviceEndpoint?.selectActiveIdentityEndpoint
					?.supportedTokens ?? []
			for (const t of tokens) {
				if (t?.pageIdToken?.pageId) {
					pageId = t.pageIdToken.pageId
					break
				}
			}

			profiles.push({
				accountName,
				channelHandle,
				pageId,
				isSelected,
			})
		}

		for (const key of Object.keys(node)) {
			walk(node[key])
		}
	}

	walk(data)
	return profiles
}

/**
 * Fetches the list of all YouTube profiles available for the given session.
 */
export const fetchAccountsList = async (
	cookieHeader: string,
	sapisid: string,
): Promise<YouTubeProfile[]> => {
	const authHeader = generateSapisidHash(sapisid)
	const res = await axios.post(
		ACCOUNTS_LIST_URL,
		{
			context: {
				client: {
					clientName: 'WEB',
					clientVersion: CLIENT_VERSION,
				},
			},
		},
		{
			headers: {
				'Content-Type': 'application/json',
				'Cookie': cookieHeader,
				'Authorization': authHeader,
				'X-Origin': 'https://www.youtube.com',
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
					'AppleWebKit/537.36 (KHTML, like Gecko) ' +
					'Chrome/120.0.0.0 Safari/537.36',
			},
			timeout: 10000,
		},
	).catch(err => {
		if (err?.response?.status === 401 || err?.response?.status === 403) {
			throw new CookieSessionError('YouTube rejected the session cookie.')
		}
		throw err
	})
	const webContext = res.data?.responseContext?.mainAppWebResponseContext
	if (webContext?.loggedOut === true) {
		throw new CookieSessionError('YouTube rejected the session cookie.')
	}
	if (res.data?.error) {
		throw new Error('YouTube could not list account profiles.')
	}
	return parseAccountsListResponse(res.data)
}

/**
 * Builds the Base64 protobuf payload required by
 * notification/modify_channel_preference.
 *
 * Wire format breakdown:
 * - Field 1 (tag 0x0a, length-delimited): channel ID string
 * - Field 2: nested Preference.index (1 personalized, 2 all, 3 none)
 * - Field 3 (tag 0x18, varint): constant 0
 * - Field 4 (tag 0x20, varint): constant 0x04
 * Layout: YouTube.js protos/misc/params.proto, NotificationPreferences.
 */
export const buildModifyChannelPreferenceParams = (
	channelId: string,
	preference: BellNotificationPreference,
): string => {
	const prefValue = BELL_PREFERENCES[preference]
	if (!Number.isInteger(prefValue)) {
		throw new Error(`Invalid bell preference: ${preference}`)
	}
	const channelBuf = Buffer.from(assertChannelId(channelId), 'utf8')
	const field1 = Buffer.concat([
		Buffer.from([0x0a, channelBuf.length]),
		channelBuf,
	])
	const field2 = Buffer.from([0x12, 0x02, 0x08, prefValue])
	const field3 = Buffer.from([0x18, 0])
	const field4 = Buffer.from([0x20, 0x04])

	return Buffer.concat([field1, field2, field3, field4]).toString('base64')
}

/**
 * Subscribes to a YouTube channel via InnerTube API.
 * Supports Brand Account delegation via pageId.
 */
export const subscribeToChannel = async (
	cookieHeader: string,
	sapisid: string,
	channelId: string,
	pageId?: string,
): Promise<any> => {
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

	const contextUser: Record<string, string> = {}
	if (pageId) {
		headers['X-Goog-PageId'] = pageId
		headers['X-Goog-AuthUser'] = '0'
		contextUser.onBehalfOfUser = pageId
	}

	const res = await axios.post(
		SUBSCRIBE_URL,
		{
			context: {
				client: {
					clientName: 'WEB',
					clientVersion: CLIENT_VERSION,
				},
				...(pageId ? { user: contextUser } : {}),
			},
			channelIds: [channelId],
		},
		{
			headers,
			timeout: 10000,
		},
	)
	return res.data
}

/**
 * Unsubscribes from a YouTube channel via InnerTube API.
 * Supports Brand Account delegation via pageId.
 */
export const unsubscribeFromChannel = async (
	cookieHeader: string,
	sapisid: string,
	channelId: string,
	pageId?: string,
): Promise<any> => {
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

	const contextUser: Record<string, string> = {}
	if (pageId) {
		headers['X-Goog-PageId'] = pageId
		headers['X-Goog-AuthUser'] = '0'
		contextUser.onBehalfOfUser = pageId
	}

	const res = await axios.post(
		UNSUBSCRIBE_URL,
		{
			context: {
				client: {
					clientName: 'WEB',
					clientVersion: CLIENT_VERSION,
				},
				...(pageId ? { user: contextUser } : {}),
			},
			channelIds: [channelId],
		},
		{
			headers,
			timeout: 10000,
		},
	)
	return res.data
}

/**
 * Updates the notification bell preference for a subscribed YouTube channel
 * ('all', 'personalized', or 'none') via InnerTube API.
 */
export const setChannelNotificationPreference = async (
	cookieHeader: string,
	sapisid: string,
	channelId: string,
	preference: BellNotificationPreference,
	pageId?: string,
): Promise<any> => {
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

	const contextUser: Record<string, string> = {}
	if (pageId) {
		headers['X-Goog-PageId'] = pageId
		headers['X-Goog-AuthUser'] = '0'
		contextUser.onBehalfOfUser = pageId
	}

	const params = buildModifyChannelPreferenceParams(channelId, preference)

	const res = await axios.post(
		MODIFY_CHANNEL_PREFERENCE_URL,
		{
			context: {
				client: {
					clientName: 'WEB',
					clientVersion: CLIENT_VERSION,
				},
				...(pageId ? { user: contextUser } : {}),
			},
			params,
		},
		{
			headers,
			timeout: 10000,
		},
	)
	return res.data
}


