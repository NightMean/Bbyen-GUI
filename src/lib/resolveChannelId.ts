import axios from 'axios'
import { isChannelId } from './channelId'

const HEADERS = {
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
		'(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	'Cookie':
		'SOCS=CAESNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQxMjE3LjA1' +
		'X3AwGgJzayACGgYIgJfnuwY',
}

const CHANNEL_ID_FROM_URL_RE =
	/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})(?:[/?&#]|$)/i

// Extract a 24-character YouTube Channel ID from raw HTML.
export const extractChannelIdFromHtml = (html: string): string | null => {
	// 1. RSS feed link in <link rel="alternate" ... href="...channel_id=UC...">
	const rssMatch = html.match(
		/channel_id=(UC[0-9A-Za-z_-]{22})(?:[&#"'\s]|$)/)
	if (rssMatch && isChannelId(rssMatch[1])) {
		return rssMatch[1]
	}

	// 2. Meta tags: <meta itemprop="identifier" content="UC...">
	const metaRe = new RegExp(
		'<meta[^>]+itemprop=["\'](?:identifier|channelId)["\'][^>]+' +
		'content=["\'](UC[0-9A-Za-z_-]{22})["\']',
		'i',
	)
	const metaMatch = html.match(metaRe)
	if (metaMatch && isChannelId(metaMatch[1])) {
		return metaMatch[1]
	}

	// 3. Canonical link: <link rel="canonical" href=".../channel/UC...">
	const canonicalRe = new RegExp(
		'<link[^>]+rel=["\']canonical["\'][^>]+' +
		'href=["\'][^"\']*\\/channel\\/(UC[0-9A-Za-z_-]{22})["\']',
		'i',
	)
	const canonicalMatch = html.match(canonicalRe)
	if (canonicalMatch && isChannelId(canonicalMatch[1])) {
		return canonicalMatch[1]
	}

	// 4. Embedded JSON properties: "channelId":"UC..." or "externalId":"UC..."
	const jsonMatch = html.match(
		/["'](?:channelId|externalId)["']\s*:\s*["'](UC[0-9A-Za-z_-]{22})["']/,
	)
	if (jsonMatch && isChannelId(jsonMatch[1])) {
		return jsonMatch[1]
	}

	return null
}

// Format an arbitrary input into an absolute HTTP URL suitable for fetching.
export const toLookupUrl = (input: string): string => {
	const trimmed = input.trim()

	if (trimmed.startsWith('@')) {
		return `https://www.youtube.com/${trimmed}`
	}
	if (/^www\.youtube\.com/i.test(trimmed) ||
			/^youtube\.com/i.test(trimmed) ||
			/^youtu\.be/i.test(trimmed)) {
		return `https://${trimmed}`
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		// Treat a bare name as a handle if it doesn't have protocol
		return `https://www.youtube.com/@${trimmed}`
	}
	return trimmed
}

/**
 * Resolves any YouTube identifier (raw 24-char ID, URL, handle @name, video)
 * to a canonical 24-char Channel ID ('UC...') without requiring an API key.
 */
export const resolveChannelId = async (input: string): Promise<string> => {
	const trimmed = input.trim()

	// 1. Fast path: already a 24-character channel ID
	if (isChannelId(trimmed)) {
		return trimmed
	}

	// 2. Fast path: URL with channel ID already in the path
	const urlMatch = trimmed.match(CHANNEL_ID_FROM_URL_RE)
	if (urlMatch && isChannelId(urlMatch[1])) {
		return urlMatch[1]
	}

	// 3. Network resolution: fetch public page and extract ID
	const targetUrl = toLookupUrl(trimmed)
	let html: string
	try {
		const response = await axios.get<string>(targetUrl, {
			headers: HEADERS,
			timeout: 10000,
			responseType: 'text',
		})
		html = response.data
	} catch (err: any) {
		const status = err?.response?.status
		if (status === 404) {
			throw new Error(
				`YouTube channel or page not found (HTTP 404) at '${targetUrl}'.`,
			)
		}
		throw new Error(
			`Failed to fetch YouTube page for '${trimmed}': ${err.message}`,
		)
	}

	const channelId = extractChannelIdFromHtml(html)
	if (channelId) {
		return channelId
	}

	throw new Error(
		`Could not extract channel ID from YouTube page '${targetUrl}'.`,
	)
}
