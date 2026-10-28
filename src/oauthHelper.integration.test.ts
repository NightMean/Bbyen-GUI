import { spawn } from 'child_process'
import { createServer, get } from 'http'
import { AddressInfo } from 'net'
import path from 'path'
import { expect, test } from 'vitest'

test('browser-PC helper receives a loopback callback and forwards it once',
	async () => {
		let port = 0
		let forwarded: unknown
		let ready!: () => void
		const started = new Promise<void>(resolve => { ready = resolve })
		const dashboard = createServer((req, res) => {
			let body = ''
			req.on('data', chunk => { body += chunk })
			req.on('end', () => {
				const data = JSON.parse(body)
				res.setHeader('Content-Type', 'application/json')
				if (req.url === '/api/oauth/desktop/start') {
					port = data.port
					res.end(JSON.stringify({ id: 'fixture-id',
						url: 'https://accounts.google.com/o/oauth2/auth?state=fixture' }))
					ready()
				} else {
					forwarded = data
					res.end(JSON.stringify({ authorized: true }))
				}
			})
		})
		await new Promise<void>(resolve =>
			dashboard.listen(0, '127.0.0.1', resolve))
		const address = dashboard.address() as AddressInfo
		const child = spawn(process.execPath, [path.resolve('web/oauth-helper.cjs'),
			`http://127.0.0.1:${address.port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''
		let printed!: () => void
		const printReady = new Promise<void>(resolve => { printed = resolve })
		child.stdout.on('data', chunk => { output += chunk.toString(); printed() })
		child.stderr.on('data', chunk => { output += chunk.toString() })
		const exit = new Promise<number | null>((resolve, reject) => {
			child.once('error', reject)
			child.once('exit', resolve)
		})
		try {
			await started
			// Wait until the helper has received the start response.
			await printReady
			const status = await new Promise<number>((resolve, reject) => {
				get(`http://127.0.0.1:${port}/authorization_code?` +
					'state=fixture-state&code=private-fixture', res => {
					res.resume(); res.on('end', () => resolve(res.statusCode!))
				}).on('error', reject)
			})
			expect(status).toBe(200)
			expect(await exit).toBe(0)
			expect(forwarded).toEqual({ id: 'fixture-id', state: 'fixture-state',
				code: 'private-fixture' })
			expect(output).not.toContain('private-fixture')
		} finally {
			child.kill()
			await new Promise<void>(resolve => dashboard.close(() => resolve()))
		}
	}, 15_000)
