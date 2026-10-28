import fs from 'fs/promises'
import path from 'path'
import http from 'http'
import { randomBytes, createHash } from 'crypto'

import open from 'open'
import { CodeChallengeMethod, Credentials, OAuth2Client }
	from 'google-auth-library'

import readline from './readline'

import setupLogger from '../../lib/logger'
import { CONFIG_DIR, CONFIG_FILE } from '../../config'
import { updateJsonFile } from '../../lib/jsonFile'
import { DeviceClient } from '../deviceAuthorization'

const READ_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'
const MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube'
const LOGIN_TIMEOUT_MS = 10 * 60_000
const TOKEN_FILE = path.join(CONFIG_DIR, '.google-auth-token.json')

/** A private generation marker; never log or expose the returned value. */
export const authorizationRevision = async () => {
	const hash = createHash('sha256')
	for (const filename of [TOKEN_FILE,
		path.join(CONFIG_DIR, 'google-credentials.json')]) {
		try {
			const data = await fs.readFile(filename)
			hash.update(String(data.length)).update(':').update(data)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			hash.update('missing:')
		}
	}
	return hash.digest('hex')
}

// Thrown when no valid token exists and interactive login is not permitted.
export class AuthError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AuthError'
	}
}

// Load config / credentials lazily inside the functions that need them,
// rather than at module import time. A top-level `import(...)` starts an
// unawaited promise that produces a floating unhandled rejection if the file
// is missing (e.g. during tests or before setup).
const readJson = async (filename: string) =>
	JSON.parse((await fs.readFile(filename)).toString())
const loadConfig = () => readJson(CONFIG_FILE)
const loadCredentials = () =>
	readJson(path.join(CONFIG_DIR, 'google-credentials.json'))

interface DeviceTokenFile {
	format: 'device-v1',
	client: DeviceClient,
	token: Credentials,
}

/** Replace the grant and client together without partial credentials. */
export const storeDeviceToken = async (
	client: DeviceClient, token: Credentials,
) => {
	if (typeof client.clientId !== 'string' || !client.clientId ||
			typeof client.clientSecret !== 'string' || !client.clientSecret ||
			typeof token.refresh_token !== 'string' || !token.refresh_token) {
		throw new AuthError('Incomplete device authorization.')
	}
	const data: DeviceTokenFile = { format: 'device-v1', client, token }
	await updateJsonFile(TOKEN_FILE, () => data, { createIfMissing: true })
}

/**
 * Store given token to `TOKEN_FILE`
 */

const storeToken = async (token: Credentials, expected: unknown) => {
	await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true })
	await updateJsonFile(TOKEN_FILE, current => {
		if (JSON.stringify(current) !== JSON.stringify(expected)) {
			throw new AuthError('Authorization changed; retry login.')
		}
		return token
	}, { createIfMissing: true })
}


/**
 * Generate new auth token
 *
 * Authorize by printing a URL and pasting back a code
 */

const genAuthToken = async (oauth2Client: OAuth2Client, manage: boolean) => {
	const logger = await setupLogger({ label: 'google-auth' })
	let previous: unknown
	try { previous = await readJson(TOKEN_FILE) } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		previous = {}
	}
	const state = randomBytes(32).toString('base64url')
	const verifier = randomBytes(32).toString('base64url')
	const challenge = createHash('sha256').update(verifier).digest('base64url')

	const authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent',
		scope: [manage ? MANAGE_SCOPE : READ_SCOPE],
		state, code_challenge_method: CodeChallengeMethod.S256,
		code_challenge: challenge,
	})

	console.log(
		'Authenticating. If a browser window is not automatically opened, ' +
		`please open the following link: ${authUrl}`)
	void open(authUrl).catch(() => {
		logger.warn('Could not open browser; use the printed login URL.')
	})

	// Set up a webserver to automatically get the code after Google redirects to
	// localhost. Resolve the port before constructing the Promise so the
	// executor itself stays synchronous (an async executor would swallow
	// rejections thrown before the first await).
	const port = (await loadConfig()).port
	let server: http.Server
	let callbackResponse: http.ServerResponse | undefined
	let exchangeStarted = false
	const manualAbort = new AbortController()
	const automatedMethod: Promise<Credentials> =
		new Promise((resolve, reject) => {
			server = http.createServer(async (req, res) => {
				let callback: URL
				try { callback = new URL(req.url ?? '/', 'http://localhost') } catch {
					res.writeHead(400).end('Invalid authorization response.')
					return
				}
				if (callback.pathname !== '/authorization_code') {
					res.writeHead(404).end()
					return
				}
				if (req.method != 'GET') {
					logger.info(`Ignoring request with unsupported method ${req.method}`)
					res.writeHead(404).end()
					return
				}

				const code = callback.searchParams.get('code')
				if (callback.searchParams.get('state') !== state || !code) {
					res.writeHead(400).end('Invalid authorization response.')
					return
				}
				if (exchangeStarted) {
					res.writeHead(409).end('Authorization is already being processed.')
					return
				}
				exchangeStarted = true

				try {
					logger.info('Creating tokens from code')
					const { tokens } = await oauth2Client.getToken({ code,
						codeVerifier: verifier })
					callbackResponse = res
					resolve(tokens)
				} catch (err) {
					res.writeHead(500).end('Authorization failed. Please try again.')
					reject(new AuthError('Authorization failed. Please try again.'))
				}
			})
			server.on('error', reject)
			server.listen(port, 'localhost')
		})

	// Also support copy/pasting the code if the automatic method does not work
	// or the system is headless
	const manualMethod = readline(
		'Paste the entire URL of the page you are redirected to ' +
		'(even if you receive 404): ', manualAbort.signal,
	)
		// Support pasting the full URL, which is more convenient than manually
		// extracting the code
		.then(value => {
			const url = new URL(value)
			if (url.protocol !== 'http:' || url.hostname !== 'localhost' ||
					url.port !== String(port) || url.pathname !== '/authorization_code' ||
					url.searchParams.get('state') !== state ||
					!url.searchParams.get('code')) {
				throw new AuthError('Invalid authorization response; retry login.')
			}
			if (exchangeStarted) {
				// The loopback callback already owns the single-use code.
				return new Promise<never>(() => undefined)
			}
			exchangeStarted = true
			return oauth2Client.getToken({ code: url.searchParams.get('code')!,
				codeVerifier: verifier }).catch(() => {
				throw new AuthError('Authorization failed. Please try again.')
			})
		})
		.then(({ tokens }) => tokens)

	let timeout: NodeJS.Timeout
	const expired = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => reject(new AuthError('Login timed out.')),
			LOGIN_TIMEOUT_MS)
	})
	try {
		const tokens = await Promise.race([automatedMethod, manualMethod, expired])
		if (!tokens.refresh_token) {
			throw new AuthError('Login returned no refresh token; retry consent.')
		}
		if (manage && !tokens.scope?.split(/\s+/).includes(MANAGE_SCOPE)) {
			throw new AuthError('YouTube management permission was not granted.')
		}
		logger.info('Storing tokens')
		await storeToken(tokens, previous)
		try {
			callbackResponse?.writeHead(200)
				.end('Authorization successful. You may now close this tab.')
		} catch {
			// The stored grant remains valid if the browser disconnects.
		}
		return tokens
	} catch (error) {
		try {
			callbackResponse?.writeHead(500)
				.end('Authorization failed. Please retry.')
		} catch {
			// Preserve the original error if the browser disconnected.
		}
		throw error
	} finally {
		clearTimeout(timeout!)
		manualAbort.abort()
		server!.close()
	}
}


/**
 * Get Google tokens, first trying to read `TOKEN_FILE` and falling back to
 * generating new ones
 */

const getToken = async () => {
	const logger = await setupLogger({ label: 'google-auth' })

	try {
		const contents = await fs.readFile(TOKEN_FILE)
		return JSON.parse(contents.toString())

	} catch (err) {

		// A missing token file is expected on first run; anything else (corrupt
		// JSON, permission error) is worth logging before we decide what to do.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			logger.info('No stored token found.')
		} else {
			logger.warn(
				`Could not read stored token (${(err as Error).message}).`)
		}

		// Normal service runs must never launch the interactive browser flow
		// (it would hang on a headless server). Only the setup/login commands
		// pass interactive: true.
		throw new AuthError(
			'No valid YouTube token. Run `npm run login` to authenticate.')
	}
}


/**
 * Create Google OAuth2Client first trying to read `TOKEN_FILE` and falling
 * back to generating new tokens
 */

const authorize = async (
	{ interactive, manage = false }: { interactive: boolean, manage?: boolean }
	= { interactive: false },
) => {
	const config = await loadConfig()
	const stored = interactive ? undefined : await getToken()
	if (stored?.format === 'device-v1') {
		if (typeof stored.client?.clientId !== 'string' ||
				!stored.client.clientId ||
				typeof stored.client?.clientSecret !== 'string' ||
				!stored.client.clientSecret ||
				typeof stored.token?.refresh_token !== 'string' ||
				!stored.token.refresh_token) {
			throw new AuthError('Stored device authorization is incomplete.')
		}
		const client = new OAuth2Client(stored.client.clientId,
			stored.client.clientSecret)
		client.setCredentials(stored.token)
		return client
	}
	const credentials = await loadCredentials()
	const oauth2Client = new OAuth2Client(
		credentials.installed.client_id,
		credentials.installed.client_secret,
		`http://localhost:${config.port}/authorization_code`,
	)

	oauth2Client.setCredentials(interactive
		? await genAuthToken(oauth2Client, manage) : stored)

	return oauth2Client
}

export default authorize
