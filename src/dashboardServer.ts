import { randomUUID } from 'crypto'
import { createServer, Server } from 'http'
import fs from 'fs/promises'
import path from 'path'
import * as sqlite from 'sqlite'
import { RefreshCoordinator, RefreshKind } from './refreshCoordinator'
import { isChannelId } from './lib/channelId'
import { listDashboardVideos, parseVideoQuery } from './dashboardVideos'

interface ChannelActions {
	add: (channelId: string) => Promise<void>,
	resolve: (input: string) => Promise<string>,
	refresh: (kind: RefreshKind) => void,
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
	const assets: Record<string, [string, string]> = {
		'/': ['index.html', 'text/html; charset=utf-8'],
		'/app.js': ['app.js', 'application/javascript; charset=utf-8'],
		'/style.css': ['style.css', 'text/css; charset=utf-8'],
		'/en.json': ['en.json', 'application/json; charset=utf-8'],
	}
	const asset = assets[url.pathname]
	if (request.method === 'GET' && asset && !url.search) {
		void fs.readFile(path.join(__dirname, '../web', asset[0])).then(data => {
			response.setHeader('Content-Type', asset[1])
			response.writeHead(200)
			response.end(data)
		}, () => send(500, { error: 'Dashboard files are unavailable.' }))
		return
	}
	if (request.method === 'POST' && !url.search && actions &&
			(url.pathname === '/api/channels' ||
			url.pathname === '/api/channels/resolve' ||
			url.pathname === '/api/refresh')) {
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
			let data: { channelId?: unknown, input?: unknown, kind?: unknown } = {}
			try { data = JSON.parse(body) ?? {} } catch { /* invalid JSON */ }
			if (url.pathname === '/api/refresh') {
				if (data.kind !== 'subscriptions' && data.kind !== 'videos') {
					send(400, { error: 'Choose a valid refresh type.' })
					return
				}
				actions.refresh(data.kind)
				send(202, { kind: data.kind })
				return
			}
			if (url.pathname === '/api/channels/resolve') {
				if (typeof data.input !== 'string' || !data.input.trim() ||
						data.input.length > 2048) {
					send(400, { error: 'Enter a YouTube channel, video, or feed.' })
					return
				}
				void actions.resolve(data.input).then(channelId => {
					if (!isChannelId(channelId)) {
						send(422, { error: 'Could not resolve this YouTube address.' })
						return
					}
					send(200, { channelId })
				}, () => send(422, {
					error: 'Could not resolve this YouTube address.',
				}))
				return
			}
			const id = data.channelId
			if (typeof id !== 'string' || !isChannelId(id)) {
				send(400, { error: 'A valid channel ID is required.' })
				return
			}
			void jobs.maintenance(randomUUID(), () => actions.add(id as string))
				.then(() => {
					actions.refresh('subscriptions')
					send(202, { channelId: id })
				},
				() => send(500, { error: 'Could not save the channel.' }))
		})
		return
	}
	if (request.method !== 'GET') {
		response.setHeader('Allow', 'GET')
		send(405, { error: 'Method not allowed.' })
		return
	}
	if ((url.search && url.pathname !== '/api/videos') ||
			!['/api/health', '/api/channels', '/api/videos',
				'/api/refresh'].includes(url.pathname)) {
		send(404, { error: 'Not found.' })
		return
	}
	if (url.pathname === '/api/health') {
		send(200, { status: 'running' })
		return
	}
	if (url.pathname === '/api/refresh') {
		// Status must remain observable while a long-running job owns the queue.
		void Promise.all([jobs.status('subscriptions'), jobs.status('videos')])
			.then(([subscriptions, videos]) => send(200, { subscriptions, videos }),
				() => send(500, { error: 'Refresh status is unavailable.' }))
		return
	}
	let query: ReturnType<typeof parseVideoQuery>
	try { query = parseVideoQuery(url.searchParams) } catch {
		send(400, { error: 'Invalid video filters.' })
		return
	}
	void jobs.maintenance(randomUUID(), async () => {
		if (url.pathname === '/api/channels') {
			return { channels: await db.all(`SELECT channelId, channelTitle,
				channelThumbnail, deleted, deletedReason, firstObservedAt, bellState,
				bellUpdatedAt FROM subscriptions ORDER BY channelTitle, channelId
				LIMIT 500`) }
		}
		return listDashboardVideos(db, query)
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
