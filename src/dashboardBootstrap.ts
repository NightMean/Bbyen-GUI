import fs from 'fs/promises'
import path from 'path'
import { RequestListener } from 'http'
import configExample from '../config.example.json'
import { serveDashboardAsset } from './dashboardAssets'
import { updateJsonFile } from './lib/jsonFile'

const exists = async (filename: string): Promise<boolean> => {
	try { await fs.access(filename); return true } catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw err
	}
}

export const missingConfiguration = async (
	config: string, channels: string,
) => ({ config: !(await exists(config)), channels: !(await exists(channels)) })

/** Setup explicitly creates missing files, never replacing existing data. */
export const createInitialFiles = async (
	config: string, channels: string, directory: string,
): Promise<void> => {
	await fs.mkdir(directory, { recursive: true })
	const create = async (filename: string, defaults: unknown) => {
		await updateJsonFile(filename, async current =>
			await exists(filename) ? current : defaults, { createIfMissing: true })
	}
	await create(config, { ...configExample, mode: 'whitelist',
		database: { filename: path.join(directory, 'database.sqlite') } })
	await create(channels, { whitelistedChannelIds: [],
		blacklistedChannelIds: [] })
}

export const createBootstrapHandler = (options: {
	config: string, channels: string, directory: string,
	start: () => Promise<void>,
}): RequestListener => {
	let busy = false
	return (request, response) => {
		response.setHeader('Cache-Control', 'no-store')
		response.setHeader('X-Content-Type-Options', 'nosniff')
		const send = (status: number, value: unknown) => {
			response.setHeader('Content-Type', 'application/json; charset=utf-8')
			response.writeHead(status); response.end(JSON.stringify(value))
		}
		let url: URL
		try { url = new URL(request.url ?? '/', 'http://localhost') } catch {
			send(400, { error: 'Invalid request.' }); return
		}
		if (serveDashboardAsset(request, response, url, true)) return
		if (request.method === 'GET' && url.pathname === '/api/setup' &&
				!url.search) {
			void missingConfiguration(options.config, options.channels).then(
				missing => send(200, { missing, busy }),
				() => send(500, { error: 'Setup files are unavailable.' }))
			return
		}
		if (request.method !== 'POST' || url.pathname !== '/api/setup/manual' ||
				url.search) { send(404, { error: 'Not found.' }); return }
		const origin = request.headers.origin
		if ((origin && origin !== `http://${request.headers.host}` &&
				origin !== `https://${request.headers.host}`) ||
				request.headers['content-type'] !== 'application/json') {
			send(403, { error: 'Invalid request origin or content type.' }); return
		}
		let body = ''
		request.setEncoding('utf8')
		request.on('data', chunk => {
			body += chunk
			if (body.length > 1024) request.destroy()
		})
		request.on('end', () => {
			try {
				const value: unknown = JSON.parse(body)
				if (!value || typeof value !== 'object' || Array.isArray(value)) {
					throw new Error('Expected an object.')
				}
			} catch { send(400, { error: 'Expected a JSON object.' }); return }
			if (busy) { send(409, { error: 'Setup is already running.' }); return }
			busy = true
			void createInitialFiles(
				options.config, options.channels, options.directory)
				.then(options.start).then(() => send(200, { ready: true }), () => {
					busy = false
					send(500, { error: 'Setup could not start. Check service logs.' })
				})
		})
	}
}
