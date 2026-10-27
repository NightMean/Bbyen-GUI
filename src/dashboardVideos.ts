import * as sqlite from 'sqlite'
import { isChannelId } from './lib/channelId'

interface VideoQuery {
	limit: number,
	offset: number,
	from?: string,
	until?: string,
	channelId?: string,
	search?: string,
}

export const parseVideoQuery = (params: URLSearchParams): VideoQuery => {
	const allowed = new Set(['limit', 'offset', 'from', 'until', 'channelId',
		'search'])
	for (const key of params.keys()) {
		if (!allowed.has(key) || params.getAll(key).length !== 1) {
			throw new Error('Invalid video filter.')
		}
	}
	const number = (key: string, fallback: number, max: number) => {
		const value = params.get(key)
		if (value === null) return fallback
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
				Number(value) > max) throw new Error('Invalid video page.')
		return Number(value)
	}
	const limit = number('limit', 100, 200)
	if (!limit) throw new Error('Invalid video page.')
	const date = (key: string) => {
		const value = params.get(key)
		if (value === null) return undefined
		const parsed = new Date(value)
		if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
				!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
			throw new Error('Invalid video date.')
		}
		return value
	}
	const from = date('from')
	const until = date('until')
	if (from && until && from >= until) throw new Error('Invalid video range.')
	const channelId = params.get('channelId') ?? undefined
	if (channelId !== undefined && !isChannelId(channelId)) {
		throw new Error('Invalid channel ID.')
	}
	const search = params.get('search') ?? undefined
	if (search !== undefined && search.length > 200) {
		throw new Error('Invalid search.')
	}
	return { limit, offset: number('offset', 0, 1_000_000), from, until,
		channelId, search }
}

export const listDashboardVideos = async (
	db: sqlite.Database, query: VideoQuery,
) => {
	const filters: string[] = []
	const values: (string | number)[] = []
	if (query.from) {
		filters.push('COALESCE(publishedAt, observedAt) >= ?')
		values.push(query.from)
	}
	if (query.until) {
		filters.push('COALESCE(publishedAt, observedAt) < ?')
		values.push(query.until)
	}
	if (query.channelId) {
		filters.push('channelId = ?')
		values.push(query.channelId)
	}
	if (query.search) {
		filters.push('instr(lower(COALESCE(title, \'\')), lower(?)) > 0')
		values.push(query.search)
	}
	const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : ''
	const total = await db.get(
		'SELECT COUNT(*) AS count FROM video_observations' + where, ...values)
	const videos = await db.all(`SELECT videoId, channelId, title, publishedAt,
		thumbnailUrl, durationSeconds, contentType, observedAt, emailOutcome, sentAt
		FROM video_observations${where}
		ORDER BY COALESCE(publishedAt, observedAt) DESC, videoId LIMIT ? OFFSET ?`,
	...values, query.limit, query.offset)
	return { videos, total: total.count, limit: query.limit,
		offset: query.offset }
}
