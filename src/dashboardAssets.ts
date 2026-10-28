import fs from 'fs/promises'
import { IncomingMessage, ServerResponse } from 'http'
import path from 'path'

/** Serve only explicitly listed files, never paths supplied by the caller. */
export const serveDashboardAsset = (
	request: IncomingMessage, response: ServerResponse, url: URL,
	setup = false,
): boolean => {
	const assets: Record<string, [string, string]> = {
		'/': [setup ? 'setup.html' : 'index.html', 'text/html; charset=utf-8'],
		'/app.js': ['app.js', 'application/javascript; charset=utf-8'],
		...(setup ? { '/setup.js': ['setup.js',
			'application/javascript; charset=utf-8'] as [string, string] } : {}),
		'/style.css': ['style.css', 'text/css; charset=utf-8'],
		'/en.json': ['en.json', 'application/json; charset=utf-8'],
		'/oauth-helper.cjs': ['oauth-helper.cjs',
			'application/octet-stream'] as [string, string],
	}
	const asset = assets[url.pathname]
	if (request.method !== 'GET' || !asset || url.search) return false
	void fs.readFile(path.join(__dirname, '../web', asset[0])).then(data => {
		response.setHeader('Content-Type', asset[1])
		response.writeHead(200)
		response.end(data)
	}, () => {
		response.setHeader('Content-Type', 'application/json; charset=utf-8')
		response.writeHead(500)
		response.end(JSON.stringify({ error: 'Dashboard files are unavailable.' }))
	})
	return true
}
