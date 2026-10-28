import * as sqlite from 'sqlite'
import { isChannelId } from './lib/channelId'

interface VideoQuery {
	limit: number,
	offset: number,
	from?: string,
	until?: string,
	channelId?: string,
	search?: string,
	contentType?: 'video' | 'short' | 'livestream' | 'unknown',
	timeZone?: string,
}

export const parseVideoQuery = (params: URLSearchParams): VideoQuery => {
	const allowed = new Set(['limit', 'offset', 'from', 'until', 'channelId',
		'search', 'contentType', 'timeZone'])
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
	const contentType = params.get('contentType') ?? undefined
	if (contentType !== undefined && !['video', 'short', 'livestream', 'unknown']
		.includes(contentType)) throw new Error('Invalid content type.')
	const timeZone = params.get('timeZone') ?? undefined
	if (timeZone !== undefined) {
		if (timeZone.length > 100) throw new Error('Invalid time zone.')
		try { new Intl.DateTimeFormat('en', { timeZone }) } catch {
			throw new Error('Invalid time zone.')
		}
	}
	return { limit, offset: number('offset', 0, 1_000_000), from, until,
		channelId, search, contentType: contentType as VideoQuery['contentType'],
		timeZone }
}

export const listDashboardVideos = async (
	db: sqlite.Database, query: VideoQuery,
) => {
	const filters: string[] = [`EXISTS (SELECT 1 FROM subscriptions s
		WHERE s.channelId = video_observations.channelId AND s.deleted=0)`]
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
	if (query.contentType === 'unknown') {
		filters.push(`(contentType IS NULL OR
			contentType NOT IN ('video', 'short', 'livestream'))`)
	} else if (query.contentType) {
		filters.push('contentType = ?')
		values.push(query.contentType)
	}
	const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : ''
	const total = await db.get(`SELECT COUNT(*) AS count,
		COALESCE(SUM(CASE WHEN durationSeconds >= 0 THEN durationSeconds END), 0)
			AS durationSeconds,
		COALESCE(SUM(CASE WHEN durationSeconds IS NULL OR durationSeconds < 0
			THEN 1 ELSE 0 END), 0) AS unknownDurationCount
		FROM video_observations${where}`, ...values)
	const videos = await db.all(`SELECT videoId, channelId, title, publishedAt,
		thumbnailUrl, durationSeconds, contentType, observedAt, emailOutcome, sentAt
		FROM video_observations${where}
		ORDER BY COALESCE(publishedAt, observedAt) DESC, videoId LIMIT ? OFFSET ?`,
	...values, query.limit, query.offset)
	const dailyCounts: Record<string, number> = Object.create(null)
	if (query.timeZone) {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: query.timeZone, year: 'numeric', month: '2-digit',
			day: '2-digit',
		})
		let rowError: Error | null = null
		await db.each(`SELECT COALESCE(publishedAt, observedAt) AS moment
			FROM video_observations${where}`, ...values,
		(err: Error | null, row: { moment: string } | null) => {
			if (err) { rowError = err; return }
			const date = new Date(row?.moment ?? '')
			if (!Number.isFinite(date.getTime())) return
			const parts = formatter.formatToParts(date)
			const part = (name: string) =>
				parts.find(item => item.type === name)?.value
			const day = `${part('year')}-${part('month')}-${part('day')}`
			dailyCounts[day] = (dailyCounts[day] ?? 0) + 1
		})
		if (rowError) throw rowError
	}
	return { videos, total: total.count, limit: query.limit,
		offset: query.offset, durationSeconds: total.durationSeconds,
		unknownDurationCount: total.unknownDurationCount, dailyCounts }
}
