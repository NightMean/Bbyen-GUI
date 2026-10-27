import * as sqlite from 'sqlite'

export const parseActivityPage = (params: URLSearchParams) => {
	for (const key of params.keys()) {
		if (!['limit', 'offset'].includes(key) || params.getAll(key).length !== 1) {
			throw new Error('Invalid activity page.')
		}
	}
	const number = (key: string, fallback: number, max: number) => {
		const value = params.get(key)
		if (value === null) return fallback
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
				Number(value) > max) throw new Error('Invalid activity page.')
		return Number(value)
	}
	const limit = number('limit', 30, 200)
	if (!limit) throw new Error('Invalid activity page.')
	return { limit, offset: number('offset', 0, 1_000_000) }
}

// Keep a deterministic tie-breaker across sources so equal timestamps do not
// duplicate or lose entries when paging through a stable history.
const activityQuery = `
	SELECT 'incident' AS kind, i.lastObservedAt AS date, i.id AS itemKey,
		json_object('id', i.id, 'source', i.source, 'category', i.category,
			'channelId', i.channelId, 'lastObservedAt', i.lastObservedAt,
			'resolvedAt', i.resolvedAt, 'reminderState', r.state,
			'recoveryState', c.state) AS value
	FROM incidents i LEFT JOIN incident_reminders r ON r.incidentId=i.id
	LEFT JOIN incident_recovery_alerts c ON c.incidentId=i.id
	UNION ALL
	SELECT 'bell', e.observedAt, printf('%020d', e.id),
		json_object('channelId', e.channelId, 'channelTitle', s.channelTitle,
			'previousState', e.previousState, 'currentState', e.currentState,
			'observedAt', e.observedAt)
	FROM cookie_channel_events e LEFT JOIN subscriptions s
		ON s.channelId=e.channelId
	UNION ALL
	SELECT 'title', e.observedAt, printf('%020d', e.id),
		json_object('previousTitle', e.previousTitle,
			'currentTitle', e.currentTitle,
			'observedAt', e.observedAt, 'emailState', e.emailState)
	FROM channel_title_events e WHERE e.observedAt >= ?
	UNION ALL
	SELECT 'added', e.observedAt, printf('%020d', e.rowid),
		json_object('title', COALESCE(s.channelTitle, e.channelId),
			'observedAt', e.observedAt, 'emailState', b.emailState)
	FROM channel_added_events e JOIN channel_added_batches b ON b.id=e.batchId
	LEFT JOIN subscriptions s ON s.channelId=e.channelId
	UNION ALL
	SELECT 'refresh', COALESCE(finishedAt, startedAt), id,
		json_object('kind', kind, 'status', status, 'startedAt', startedAt,
			'finishedAt', finishedAt, 'resultStatus',
			CASE WHEN json_valid(resultJson)
			THEN json_extract(resultJson, '$.status') ELSE NULL END,
			'succeeded', CASE WHEN json_valid(resultJson)
			THEN json_extract(resultJson, '$.succeeded') ELSE NULL END,
			'failed', CASE WHEN json_valid(resultJson)
			THEN json_extract(resultJson, '$.failed') ELSE NULL END)
	FROM refresh_runs`

export const listActivity = async (db: sqlite.Database,
	page: ReturnType<typeof parseActivityPage>) => {
	const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
	const count = await db.get(`SELECT COUNT(*) AS total FROM (${activityQuery})`,
		cutoff)
	const rows = await db.all(`SELECT * FROM (${activityQuery})
		ORDER BY date DESC, kind, itemKey DESC LIMIT ? OFFSET ?`,
	cutoff, page.limit, page.offset)
	return { total: count.total, items: rows.map(row => ({ kind: row.kind,
		date: row.date, value: JSON.parse(row.value) })) }
}
