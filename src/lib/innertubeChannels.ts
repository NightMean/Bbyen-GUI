import crypto from 'crypto'
import axios from 'axios'

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
const CLIENT_VERSION = '2.20240101.00.00'

/**
 * Normalizes cookies from any format (JSON array from browser extensions,
 * Netscape cookies.txt, or raw header string) into a standard Cookie header.
 */
export const normalizeCookieHeader = (rawCookie: string): string => {
	const trimmed = rawCookie.trim()
	if (!trimmed) return ''

	// 1. JSON array format (e.g. from Cookie-Editor / EditThisCookie)
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed)
			if (Array.isArray(parsed)) {
				return parsed
					.filter(c => c && c.name && c.value !== undefined)
					.map(c => `${c.name}=${c.value}`)
					.join('; ')
			}
		} catch {
			// Fallback to raw string
		}
	}

	// 2. Netscape cookies.txt format
	if (trimmed.includes('\t') && !trimmed.includes(';')) {
		const pairs: string[] = []
		for (const line of trimmed.split('\n')) {
			const clean = line.trim()
			if (!clean || clean.startsWith('#')) continue
			const parts = clean.split('\t')
			if (parts.length >= 7) {
				pairs.push(`${parts[5]}=${parts[6]}`)
			}
		}
		if (pairs.length) return pairs.join('; ')
	}

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
	timestamp = Date.now(),
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
} => {
	const channels: ChannelBellState[] = []
	const seenIds = new Set<string>()
	let continuationToken: string | null = null

	const walk = (node: any) => {
		if (!node || typeof node !== 'object') return

		if (node.channelRenderer) {
			const parsed = parseChannelRenderer(node.channelRenderer)
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
	return { channels, continuationToken }
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
	)
	return parseAccountsListResponse(res.data)
}

