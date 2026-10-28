#!/usr/bin/env node
'use strict'

// Run on the browser PC, so Google's Desktop callback reaches its own loopback.
const http = require('http')
const https = require('https')

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log('BBYEN OAuth helper protocol 1.0.0')
  process.exit(0)
}
if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length !== 3) {
  console.log('Usage: node oauth-helper.cjs <dashboard-origin>\nOpen the printed Google link on this computer.')
  process.exit(process.argv.length === 3 ? 0 : 1)
}

let base
try {
  base = new URL(process.argv[2])
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('invalid')
} catch {
  console.error('Enter the dashboard origin, for example http://server:3031.')
  process.exit(1)
}
const post = (route, data) => new Promise((resolve, reject) => {
  const body = JSON.stringify(data)
  const target = new URL(route, base)
  const request = (target.protocol === 'https:' ? https : http).request(target, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 60000,
  }, response => {
    let value = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { value += chunk; if (value.length > 65536) request.destroy() })
    response.on('end', () => {
      try {
        if (response.statusCode !== 200) throw new Error('request failed')
        resolve(JSON.parse(value))
      } catch { reject(new Error('Dashboard request failed.')) }
    })
  })
  request.on('timeout', () => request.destroy())
  request.on('error', () => reject(new Error('Could not reach the dashboard.')))
  request.end(body)
})

let session
let received = false
const server = http.createServer(async (request, response) => {
  let callback
  try { callback = new URL(request.url, 'http://127.0.0.1') } catch { response.writeHead(400).end('Invalid response.'); return }
  if (request.method !== 'GET' || callback.pathname !== '/authorization_code' || !session || received) {
    response.writeHead(404).end(); return
  }
  received = true
  try {
    await post('/api/oauth/desktop/finish', { id: session.id, state: callback.searchParams.get('state'), code: callback.searchParams.get('code') })
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Authorization complete. You may close this tab.')
    console.log('Authorization complete. Return to BBYEN Settings.')
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Authorization failed. Return to BBYEN and try again.')
    console.error('Authorization failed. Check the Google client and selected YouTube profile.')
    process.exitCode = 1
  } finally { server.close() }
})
server.on('error', () => { console.error('Could not start the local callback listener.'); process.exitCode = 1 })
server.listen(0, '127.0.0.1', async () => {
  const timer = setTimeout(() => { console.error('Authorization timed out.'); process.exitCode = 1; server.close() }, 10 * 60 * 1000)
  timer.unref()
  server.once('close', () => clearTimeout(timer))
  try {
    session = await post('/api/oauth/desktop/start', { port: server.address().port })
    const url = new URL(session.url)
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('invalid')
    console.log(`Open this Google link in the browser on this computer:\n${url.href}`)
  } catch {
    console.error('Could not start Google authorization. Check the dashboard and Desktop client credentials.')
    process.exitCode = 1; server.close()
  }
})
