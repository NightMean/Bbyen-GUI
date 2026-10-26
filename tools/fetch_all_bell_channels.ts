#!/usr/bin/env ts-node
import fs from 'fs/promises'
import path from 'path'
import axios from 'axios'

import {
	generateSapisidHash,
	extractSapisidFromCookie,
	normalizeCookieHeader,
	extractChannelsFromInnerTube,
	fetchAccountsList,
	YouTubeProfile,
	ChannelBellState,
} from '../src/lib/innertubeChannels'
import { CHANNELS_FILE, loadEmailConfig, loadConfigRaw } from '../src/config'
import * as mailer from '../src/email'
import { classifyError } from '../src/lib/classifyError'
import { notifyError } from '../src/lib/alertState'
import * as database from '../src/database'
import {
	mergeChannelEntries, parseChannelLists,
} from '../src/lib/channelConfig'
import { updateJsonFile } from '../src/lib/jsonFile'

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/browse'
const ACCOUNT_MENU_URL =
	'https://www.youtube.com/youtubei/v1/account/account_menu'
const CLIENT_VERSION = '2.20240101.00.00'

interface FetchOptions {
	cookie: string
	account?: string
	pageId?: string
	saveToChannelsJson?: boolean
}

export const fetchAccountName = async (
	cookieHeader: string,
	sapisid: string,
	pageId?: string,
): Promise<string | null> => {
	try {
		const authHeader = generateSapisidHash(sapisid)
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Cookie': cookieHeader,
			'Authorization': authHeader,
			'X-Origin': 'https://www.youtube.com',
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
				'AppleWebKit/537.36 (KHTML, like Gecko) ' +
				'Chrome/120.0.0.0 Safari/537.36',
		}
		if (pageId) {
			headers['X-Goog-PageId'] = pageId
			headers['X-Goog-AuthUser'] = '0'
		}

		const context: Record<string, unknown> = {
			client: {
				clientName: 'WEB',
				clientVersion: CLIENT_VERSION,
			},
		}
		if (pageId) {
			context.user = { onBehalfOfUser: pageId }
		}

		const res = await axios.post(
			ACCOUNT_MENU_URL,
			{ context },
			{ headers, timeout: 10000 },
		)
		const str = JSON.stringify(res.data)
		const match = str.match(/"accountName":\{"simpleText":"([^"]+)"\}/)
		return match ? match[1] : null
	} catch {
		return null
	}
}

export const trySendAuthAlertEmail = async (err: Error): Promise<void> => {
	try {
		const raw = await loadConfigRaw()
		if (!raw.logging?.emailOnError) return

		const emailConfig = await loadEmailConfig()
		const mailers = await mailer.init(emailConfig)
		await notifyError(classifyError(err), err, {
			sendErrorEmail: mailers.sendErrorEmail,
			emailOnError: true,
			logger: {
				info: (msg: string) => console.log(`[Alert] ${msg}`),
				warn: (msg: string) => console.warn(`[Alert] ${msg}`),
				error: (e: unknown) => console.error('[Alert]', e),
			},
		})
	} catch {
		// Email configuration unavailable or incomplete; skip alert email
	}
}

export const resolveTargetProfile = async (
	cookieHeader: string,
	sapisid: string,
	options: { account?: string; pageId?: string },
): Promise<{ pageId?: string; accountName: string }> => {
	let profiles: YouTubeProfile[] = []
	try {
		profiles = await fetchAccountsList(cookieHeader, sapisid)
	} catch {
		// If accounts_list fails, fall back to direct options
	}

	let configAccount: string | undefined
	let configPageId: string | undefined
	try {
		const raw = await loadConfigRaw()
		const anyRaw = raw as unknown as Record<string, unknown>
		if (typeof anyRaw.youtubeAccount === 'string') {
			configAccount = anyRaw.youtubeAccount
		}
		if (typeof anyRaw.youtubePageId === 'string') {
			configPageId = anyRaw.youtubePageId
		}
	} catch {
		// config.json not yet initialized
	}

	const explicitAccount =
		options.account || process.env.YOUTUBE_ACCOUNT || configAccount
	const explicitPageId =
		options.pageId || process.env.YOUTUBE_PAGE_ID || configPageId

	if (explicitPageId) {
		const matched = profiles.find(p => p.pageId === explicitPageId)
		return {
			pageId: explicitPageId,
			accountName: matched?.accountName ?? `PageID ${explicitPageId}`,
		}
	}

	if (explicitAccount) {
		const search = explicitAccount.toLowerCase()
		const matched = profiles.find(
			p =>
				p.accountName.toLowerCase() === search ||
				p.channelHandle?.toLowerCase() === search ||
				p.accountName.toLowerCase().includes(search),
		)
		if (matched) {
			return {
				pageId: matched.pageId,
				accountName: matched.accountName,
			}
		}

		const names = profiles.map(p => `"${p.accountName}"`).join(', ')
		throw new Error(
			`Profile "${explicitAccount}" not found in session cookies.\n` +
				`Available profiles: ${names || 'None detected'}`,
		)
	}

	// Active default profile (or the one with isSelected: true)
	const selected = profiles.find(p => p.isSelected)
	if (selected) {
		if (profiles.length > 1) {
			console.log('Available accounts in session:')
			for (const p of profiles) {
				const tag = p.isSelected ? ' (active default)' : ''
				const handle = p.channelHandle ? ` (${p.channelHandle})` : ''
				console.log(`  - ${p.accountName}${handle}${tag}`)
			}
			console.log('Tip: Use --account "<name>" to select a profile.')
		}
		return {
			pageId: selected.pageId,
			accountName: selected.accountName,
		}
	}

	const fallbackName = await fetchAccountName(cookieHeader, sapisid)
	return {
		accountName: fallbackName ?? 'Unknown YouTube User',
	}
}

export const fetchAllBellChannels = async (
	options: FetchOptions,
): Promise<ChannelBellState[]> => {
	const cookieHeader = normalizeCookieHeader(options.cookie)
	const sapisid = extractSapisidFromCookie(cookieHeader)
	if (!sapisid) {
		throw new Error(
			'Could not find SAPISID or __Secure-3PAPISID in cookie.\n' +
				'Provide cookie as JSON array (from Cookie-Editor), ' +
				'Netscape file, or raw header.',
		)
	}

	const { pageId, accountName } = await resolveTargetProfile(
		cookieHeader,
		sapisid,
		{ account: options.account, pageId: options.pageId },
	)

	const pageIdTag = pageId ? ` [Brand PageId: ${pageId}]` : ''
	console.log(`Connected to YouTube account: ${accountName}${pageIdTag}`)

	const allBellMap = new Map<string, ChannelBellState>()
	let continuationToken: string | null = null
	let page = 1

	console.log('Fetching subscriptions from YouTube InnerTube API...')

	while (true) {
		const authHeader = generateSapisidHash(sapisid)
		const payload: Record<string, unknown> = {
			context: {
				client: {
					clientName: 'WEB',
					clientVersion: CLIENT_VERSION,
					hl: 'en',
					gl: 'US',
				},
			},
		}

		if (pageId) {
			const ctx = payload.context as Record<string, unknown>
			ctx.user = { onBehalfOfUser: pageId }
		}

		if (continuationToken) {
			payload.continuation = continuationToken
		} else {
			payload.browseId = 'FEchannels'
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Cookie': cookieHeader,
			'Authorization': authHeader,
			'X-Origin': 'https://www.youtube.com',
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
				'AppleWebKit/537.36 (KHTML, like Gecko) ' +
				'Chrome/120.0.0.0 Safari/537.36',
		}

		if (pageId) {
			headers['X-Goog-PageId'] = pageId
			headers['X-Goog-AuthUser'] = '0'
		}

		let response: any
		try {
			response = await axios.post(INNERTUBE_API_URL, payload, {
				headers,
				timeout: 15000,
			})
		} catch (err: any) {
			const status = err?.response?.status
			if (status === 401 || status === 403) {
				const authErr = new Error(
					'YouTube session cookie has expired or is invalid. ' +
						'Please update cookies.txt with a fresh session.',
				)
				await trySendAuthAlertEmail(authErr)
				throw authErr
			}
			throw err
		}

		const extracted = extractChannelsFromInnerTube(response.data)
		const bellChannels = extracted.channels.filter(c => c.isAllNotifications)
		for (const ch of bellChannels) {
			allBellMap.set(ch.channelId, ch)
		}

		console.log(
			`  Page ${page}: extracted ${extracted.channels.length} channels ` +
				`(${bellChannels.length} with All notifications).`,
		)

		if (
			!extracted.continuationToken ||
			extracted.continuationToken === continuationToken
		) {
			break
		}
		continuationToken = extracted.continuationToken
		page++
	}

	const allBellChannels = Array.from(allBellMap.values())
	console.log(
		`\nTotal channels with "All" notifications: ${allBellChannels.length}`,
	)

	if (options.saveToChannelsJson) {
		const saved = await updateJsonFile(CHANNELS_FILE, value => {
			const lists = parseChannelLists(value)
			return { ...lists, whitelistedChannelIds: mergeChannelEntries([
				...(lists.whitelistedChannelIds ?? []),
				...allBellChannels.map(channel => channel.channelId),
			]) }
		})
		console.log(`Saved ${saved.whitelistedChannelIds.length} total channels.`)

		// Also record bell state history in SQLite if database is configured
		try {
			const raw = await loadConfigRaw()
			const db = await database.init(raw.database)
			for (const ch of allBellChannels) {
				await database.recordSubscriptionBellState(
					db,
					ch.channelId,
					ch.title,
					ch.notificationState,
				)
			}
			await db.close()
			console.log('Recorded bell history in SQLite database.')
		} catch {
			// Database not set up or configured yet; ignore
		}
	}

	return allBellChannels
}

const main = async () => {
	const args = process.argv.slice(2)

	if (args.includes('--help') || args.includes('-h')) {
		console.log([
			'bbyen channel sync - extract channels with "All" notification bell',
			'',
			'Usage:',
			'  npm run sync-channels -- [options]',
			'',
			'Options:',
			'  -s, --save            Save extracted IDs to channels.json & SQLite',
			'  -l, --list-accounts   List all YouTube profiles in session',
			'  -a, --account <name>  Select account/brand profile by name or handle',
			'  --pageId <id>         Select brand profile by Google pageId',
			'  --cookie <str>        Pass raw cookie string instead of cookies.txt',
			'  -v, --version         Show version information',
			'  -h, --help            Show this help reference',
		].join('\n'))
		process.exit(0)
	}

	if (args.includes('--version') || args.includes('-v')) {
		console.log('bbyen-sync v3.2.0')
		process.exit(0)
	}

	const saveFlag = args.includes('--save') || args.includes('-s')
	const listAccountsFlag =
		args.includes('--list-accounts') || args.includes('-l')

	let accountArg: string | undefined
	const accountIdx = args.findIndex(a => a === '--account' || a === '-a')
	if (accountIdx !== -1 && args[accountIdx + 1]) {
		accountArg = args[accountIdx + 1]
	}

	let pageIdArg: string | undefined
	const pageIdIdx = args.findIndex(a => a === '--pageId')
	if (pageIdIdx !== -1 && args[pageIdIdx + 1]) {
		pageIdArg = args[pageIdIdx + 1]
	}

	let cookie = process.env.YOUTUBE_COOKIE ?? ''
	const cookieArgIdx = args.findIndex(a => a === '--cookie')
	if (cookieArgIdx !== -1 && args[cookieArgIdx + 1]) {
		cookie = args[cookieArgIdx + 1]
	}

	if (!cookie) {
		const candidatePaths = [
			path.join(process.cwd(), 'cookies.txt'),
			path.join(__dirname, '..', 'cookies.txt'),
		]
		for (const p of candidatePaths) {
			try {
				cookie = (await fs.readFile(p)).toString().trim()
				console.log(`Loaded cookie from ${p}`)
				break
			} catch {
				// Try next candidate
			}
		}
	}

	if (!cookie) {
		console.error(
			'Error: No YouTube cookie provided.\n' +
				'Provide cookie via YOUTUBE_COOKIE env var, --cookie <string>, ' +
				'or cookies.txt in bbyen directory.',
		)
		process.exit(1)
	}

	const cookieHeader = normalizeCookieHeader(cookie)
	const sapisid = extractSapisidFromCookie(cookieHeader)
	if (!sapisid) {
		console.error('Error: Could not find SAPISID in cookie.')
		process.exit(1)
	}

	if (listAccountsFlag) {
		try {
			const profiles = await fetchAccountsList(cookieHeader, sapisid)
			console.log(`\nFound ${profiles.length} profile(s) in session:`)
			for (const p of profiles) {
				const tag = p.isSelected ? ' [ACTIVE DEFAULT]' : ''
				const handle = p.channelHandle ? ` (${p.channelHandle})` : ''
				const page = p.pageId ? ` [PageId: ${p.pageId}]` : ' [Primary]'
				console.log(`  * ${p.accountName}${handle}${page}${tag}`)
			}
			console.log(
				'\nRun with --account "<name>" or --pageId <id> to select.',
			)
			process.exit(0)
		} catch (err) {
			console.error(`Error listing accounts: ${(err as Error).message}`)
			process.exit(1)
		}
	}

	try {
		const channels = await fetchAllBellChannels({
			cookie,
			account: accountArg,
			pageId: pageIdArg,
			saveToChannelsJson: saveFlag,
		})
		for (const ch of channels.slice(0, 20)) {
			console.log(`  🔔 [ALL] ${ch.title} (${ch.channelId})`)
		}
		if (channels.length > 20) {
			console.log(`  ... and ${channels.length - 20} more.`)
		}
	} catch (err) {
		const asError = err as Error
		await trySendAuthAlertEmail(asError)
		console.error(`Error: ${asError.message}`)
		process.exit(1)
	}
}

if (require.main === module) {
	main()
}
