import { randomUUID } from 'crypto'
import { createServer, Server } from 'http'
import * as sqlite from 'sqlite'
import { RefreshCoordinator } from './refreshCoordinator'
import { isChannelId } from './lib/channelId'

interface ChannelActions {
	add: (channelId: string) => Promise<void>,
	refresh: () => void,
}

/** Dashboard API. Database work shares the refresh queue. */
export const createDashboardServer = (
	db: sqlite.Database, jobs: RefreshCoordinator, actions?: ChannelActions,
): Server => createServer((request, response) => {
	response.setHeader('Content-Type', 'application/json; charset=utf-8')
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('X-Content-Type-Options', 'nosniff')
	const send = (status: number, value: unknown) => {
		response.writeHead(status)
		response.end(JSON.stringify(value))
	}
	let url: URL
	try { url = new URL(request.url ?? '/', 'http://localhost') } catch {
		send(400, { error: 'Invalid request.' })
		return
	}
	if (request.method === 'POST' && url.pathname === '/api/channels' &&
			!url.search && actions) {
		const origin = request.headers.origin
		if ((origin && origin !== `http://${request.headers.host}` &&
				origin !== `https://${request.headers.host}`) ||
				request.headers['content-type'] !== 'application/json') {
			send(403, { error: 'Request origin or content type is invalid.' })
			return
		}
		let body = ''
		request.setEncoding('utf8')
		request.on('data', chunk => {
			body += chunk
			if (body.length > 4096) request.destroy()
		})
		request.on('end', () => {
			let id: unknown
			try { id = JSON.parse(body).channelId } catch { /* invalid JSON */ }
			if (typeof id !== 'string' || !isChannelId(id)) {
				send(400, { error: 'A valid channel ID is required.' })
				return
			}
			void jobs.maintenance(randomUUID(), () => actions.add(id as string))
				.then(() => { actions.refresh(); send(202, { channelId: id }) },
					() => send(500, { error: 'Could not save the channel.' }))
		})
		return
	}
	if (request.method !== 'GET') {
		response.setHeader('Allow', 'GET')
		send(405, { error: 'Method not allowed.' })
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
