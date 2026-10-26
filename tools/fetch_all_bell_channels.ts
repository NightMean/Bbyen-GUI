#!/usr/bin/env ts-node
import fs from 'fs/promises'
import path from 'path'
import {
	extractSapisidFromCookie,
	normalizeCookieHeader,
	fetchAccountsList,
	ChannelBellState,
} from '../src/lib/innertubeChannels'
import {
	CookieFetchOptions, CookieSessionError, fetchCookieChannels,
} from '../src/lib/cookieDiscovery'
import { CHANNELS_FILE, loadEmailConfig, loadConfigRaw } from '../src/config'
import * as mailer from '../src/email'
import { classifyError } from '../src/lib/classifyError'
import { notifyError } from '../src/lib/alertState'
import * as database from '../src/database'
import {
	mergeChannelEntries, parseChannelLists,
} from '../src/lib/channelConfig'
import { updateJsonFile } from '../src/lib/jsonFile'

interface FetchOptions extends CookieFetchOptions {
	saveToChannelsJson?: boolean,
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

export const fetchAllBellChannels = async (
	options: FetchOptions,
): Promise<ChannelBellState[]> => {
	let observed: ChannelBellState[]
	try {
		observed = await fetchCookieChannels(options)
	} catch (err) {
		if (err instanceof CookieSessionError) await trySendAuthAlertEmail(err)
		throw err
	}
	const allBellChannels = observed.filter(channel => channel.isAllNotifications)

	if (options.saveToChannelsJson) {
		const saved = await updateJsonFile(CHANNELS_FILE, value => {
			const lists = parseChannelLists(value)
			return { ...lists, whitelistedChannelIds: mergeChannelEntries([
				...(lists.whitelistedChannelIds ?? []),
				...allBellChannels.map(channel => channel.channelId),
			]) }
		}, { createIfMissing: true })
		console.log(`Saved ${saved.whitelistedChannelIds.length} total channels.`)

		// The whitelist imports All channels, while history records every state.
		// File and database writes cannot be one atomic operation: failures after
		// the file save report that partial outcome and can safely be retried.
		try {
			const raw = await loadConfigRaw()
			const db = await database.init(raw.database)
			let transactionStarted = false
			try {
				await db.exec('BEGIN IMMEDIATE')
				transactionStarted = true
				for (const ch of observed) {
					await database.recordSubscriptionBellState(
						db, ch.channelId, ch.title, ch.notificationState,
					)
				}
				await db.exec('COMMIT')
				transactionStarted = false
			} catch (err) {
				if (transactionStarted) {
					await db.exec('ROLLBACK').catch(() => {
						console.warn('Could not roll back bell history transaction.')
					})
				}
				throw err
			} finally {
				await db.close()
			}
			console.log('Recorded bell history in SQLite database.')
		} catch (err) {
			throw new Error('channels.json was saved, but recording bell history ' +
				`in the database failed: ${(err as Error).message}. Retry the sync.`)
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
