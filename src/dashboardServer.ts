import { randomUUID } from 'crypto'
import { createServer, Server } from 'http'
import * as sqlite from 'sqlite'
import { RefreshCoordinator } from './refreshCoordinator'

/** Read-only dashboard API. Database work shares the refresh queue. */
export const createDashboardServer = (
	db: sqlite.Database, jobs: RefreshCoordinator,
): Server => createServer((request, response) => {
	response.setHeader('Content-Type', 'application/json; charset=utf-8')
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('X-Content-Type-Options', 'nosniff')
	const send = (status: number, value: unknown) => {
		response.writeHead(status)
		response.end(JSON.stringify(value))
	}
	if (request.method !== 'GET') {
		response.setHeader('Allow', 'GET')
		send(405, { error: 'Method not allowed.' })
		return
	}
	let url: URL
	try { url = new URL(request.url ?? '/', 'http://localhost') } catch {
		send(400, { error: 'Invalid request.' })
		return
	}
	if (url.search || !['/api/health', '/api/channels', '/api/videos',
		'/api/refresh'].includes(url.pathname)) {
		send(404, { error: 'Not found.' })
		return
	}
	if (url.pathname === '/api/health') {
		send(200, { status: 'running' })
		return
	}
	void jobs.maintenance(randomUUID(), async () => {
		if (url.pathname === '/api/channels') {
			return { channels: await db.all(`SELECT channelId, channelTitle,
				channelThumbnail, deleted, deletedReason, firstObservedAt, bellState,
				bellUpdatedAt FROM subscriptions ORDER BY channelTitle, channelId
				LIMIT 500`) }
		}
		if (url.pathname === '/api/videos') {
			return { videos: await db.all(`SELECT videoId, channelId, title,
				publishedAt, thumbnailUrl, durationSeconds, contentType, observedAt,
				emailOutcome, sentAt FROM video_observations
				ORDER BY COALESCE(publishedAt, observedAt) DESC, videoId LIMIT 500`) }
		}
		return { subscriptions: await jobs.status('subscriptions'),
			videos: await jobs.status('videos') }
	}).then(result => send(200, result), () => {
		send(500, { error: 'Dashboard data is temporarily unavailable.' })
	})
})

export const dashboardPort = (value: string | undefined): number => {
	if (value === undefined) return 3031
	if (!/^\d+$/.test(value)) throw new Error('Invalid BBYEN_DASHBOARD_PORT.')
	const port = Number(value)
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error('Invalid BBYEN_DASHBOARD_PORT.')
	}
	return port
}
