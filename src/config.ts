import process from 'process'
import axios from 'axios'
import path from 'path'
import fs from 'fs/promises'
import JSSoup from 'jssoup'
import winston from 'winston'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'

import configSchema from '../config.example.json'
import { resolveChannelId } from './lib/resolveChannelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'
import { BacklogPolicy, parseBacklogPolicy } from './initialBacklog'
import { parseVideoRetentionDays } from './videoRetention'
import { EmailSelectionPolicy, parseEmailSelectionPolicy } from './emailPolicy'

export const CONFIG_DIR = process.env.CONFIG_DIR ?? path.join(__dirname, '..')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
export const CHANNELS_FILE = path.join(CONFIG_DIR, 'channels.json')
export const SECRETS_FILE = path.join(CONFIG_DIR, 'secrets.json')

export interface EmailConfig {
	host: string,
	port: number,
	secure: boolean,
	auth: {
		user: string,
		pass: string,
	},
	sendingContact: string,
	destination: string,
}

export interface ChannelEntry {
	id: string,
	notify?: boolean,
	notifyOnFirstScan?: boolean,
	initialBacklog?: BacklogPolicy,
}

export type RawChannelEntry = string | {
	id: string,
	notify?: boolean,
	notifyOnFirstScan?: boolean,
	initialBacklog?: BacklogPolicy,
}

export interface Config {
	email: EmailConfig,
	mode: 'youtube' | 'whitelist',
	port: number,
	database: {
		filename: string,
	},
	timers: {
		subscriptions: '2 days',
		videos: '20 minutes'
	},
	kickoff: {
		subscriptions: boolean,
		videos: boolean,
	},
	logging: {
		level: 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly',
		stackTraceLimit: number,
		emailOnError: boolean,
	},
	notifyOnFirstScan: boolean,
	initialBacklog?: BacklogPolicy,
	videoRetentionDays?: number | null,
	emailSelectionPolicy?: EmailSelectionPolicy,
	whitelistedChannelIds?: ChannelEntry[],
	blacklistedChannelIds?: ChannelEntry[],
	manualChannelIds?: ChannelEntry[],
	channelSettingsById?: Map<string, ChannelEntry>,
}

// Check that all the keys present in the example config file are also present
// in the supplied config file
// Eventually, we might need something more sophisticated (i.e. optional
// settings), but for now, this is sufficient.
const validateConfig = (
	received: any,
	expected: any = configSchema,
	path: string[] = [],
) => {
	if (typeof expected === 'string') {
		return
	}

	for (const [key, val] of Object.entries(expected)) {
		if (!(key in received)) {
			if (path.length === 0 && key === 'emailSelectionPolicy') continue
			console.error([
				`Your config file is missing the key '${[...path, key].join('.')}'.`,
				'Please check your config file and the README.md.'
			].join(' '))
			process.exit(1)
		}
		validateConfig(received[key], val, [...path, key])
	}
}


// Get the ID for a given channel URL by scraping the channel page and parsing
// the `ytInitialData` variable
const getChannelIdFromUrlScrape = async (url: string) => {
	try {
		const response = await axios(url)
		const soup = new JSSoup(response.data)
		const scripts = soup.findAll('script')
		const jsonString = scripts
			.map(e => e.text as string)
			.filter(t => t.startsWith('var ytInitialData = '))[0]
			.replace('var ytInitialData = ', '')
			.replace(/;$/, '')
		const data = JSON.parse(jsonString)
		const RSSURL = data.metadata.channelMetadataRenderer.rssUrl
		const channelId = new URL(RSSURL).searchParams.get('channel_id')
		return channelId
	} catch (err) {
		console.log(err)
		throw err
	}
}

// Get the ID for a given channel using the YouTube data API
// There's no official way to do this, the only way I have seen is to search for
// the channel URL, which is kind of stupid
// This doesn't always work, hence the above method
const getChannelIdFromUrlAPI = async (
	service: youtube_v3.Youtube,
	auth: OAuth2Client,
	channel: string,
) => {
	const res = await service.search.list({
		auth,
		part: ['id'],
		q: channel,
		maxResults: 1,
		order: 'relevance',
		type: ['channel'],
	})

	const items = res.data.items

	if (!items?.length) {
		console.log(JSON.stringify(res.data))
		throw new Error([
			`Could not find channel ID using the API for '${channel}'.`,
			'Please open a GitHub issue and show them this message:',
			'https://github.com/MarcelRobitaille/bbyen/issues/new',
		].join(' '))
	}
	return items[0].id?.channelId
}

// Get the channel ID from the URL or handle using scraper or YouTube API
export const normalizeChannelFactory = (
	logger: winston.Logger,
	service?: youtube_v3.Youtube,
	auth?: OAuth2Client,
) => async (channel: string) => {
	logger.verbose(`Normalizing channel string '${channel}'`)

	// 1. Try no-API resolution (handles raw IDs, URLs with IDs, @handles)
	try {
		return await resolveChannelId(channel)
	} catch (err) {
		logger.verbose(
			`Non-API resolution failed for '${channel}': ${(err as Error).message}`,
		)
	}

	// 2. If YouTube Data API credentials are provided, try search API as fallback
	if (service && auth) {
		try {
			return await getChannelIdFromUrlAPI(service, auth, channel)
		} catch (err) {
			logger.verbose(
				`API resolution failed for '${channel}': ${(err as Error).message}`,
			)
		}
	}

	throw new Error([
		`Exhausted all methods of getting the ID for channel '${channel}'.`,
		'If this is a mistake, please open a GitHub issue',
		'and show them this message:',
		'https://github.com/MarcelRobitaille/bbyen/issues/new',
	].join(' '))
}

// Resolve email credentials: env vars win, secrets.json is the fallback.
// Fail loud if neither source provides both values.
export const resolveEmailCredentials = (
	secrets: { email?: { auth?: { user?: string, pass?: string } } } | null,
	legacyAuth?: Partial<EmailConfig['auth']>,
): { user: string, pass: string } => {
	const user = process.env.BBYEN_EMAIL_USER ??
		secrets?.email?.auth?.user ?? legacyAuth?.user
	const pass = process.env.BBYEN_EMAIL_PASS ??
		secrets?.email?.auth?.pass ?? legacyAuth?.pass
	if (!user || !pass) {
		throw new Error([
			'Email credentials missing.',
			'Set BBYEN_EMAIL_USER and BBYEN_EMAIL_PASS,',
			'or provide secrets.json with email.auth.user and email.auth.pass.',
		].join(' '))
	}
	return { user, pass }
}

// Turn a raw channels.json entry (string or object) into a ChannelEntry with a
// canonical channel id. Preserves the notify / notifyOnFirstScan flags.
export const normalizeChannelEntries = async (
	normalizeChannel: (channel: string) => Promise<string>,
	entries: RawChannelEntry[] | undefined,
): Promise<ChannelEntry[] | undefined> => {
	if (!entries) {
		return undefined
	}
	return mergeChannelEntries(await Promise.all(entries.map(async (entry) => {
		if (typeof entry === 'string') {
			return { id: await normalizeChannel(entry) }
		}
		return { ...entry, id: await normalizeChannel(entry.id) }
	})))
}

// Build an O(1) lookup keyed by channel id, containing only entries that carry
// a per-channel setting (notify or notifyOnFirstScan). Derived state, not
// persisted.
export const buildChannelSettingsMap = (
	entries: ChannelEntry[] | undefined,
): Map<string, ChannelEntry> => {
	const map = new Map<string, ChannelEntry>()
	for (const entry of entries ?? []) {
		if (entry.initialBacklog !== undefined || entry.notify !== undefined ||
				entry.notifyOnFirstScan !== undefined) {
			map.set(entry.id, entry)
		}
	}
	return map
}

// Read just the email configuration (general config file + resolved
// credentials). Exposed so the mailer can be initialized before YouTube auth,
// allowing a startup auth failure to be emailed.
export const loadEmailConfig = async (): Promise<EmailConfig> => {
	const general = JSON.parse((await fs.readFile(CONFIG_FILE)).toString())

	let secrets: { email?: { auth?: { user?: string, pass?: string } } } | null
		= null
	try {
		secrets = JSON.parse((await fs.readFile(SECRETS_FILE)).toString())
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err
		}
	}
	const { user, pass } = resolveEmailCredentials(secrets, general.email?.auth)
	return { ...general.email, auth: { user, pass } }
}

// Read the raw config file without channel normalization (which may call the
// API). Used at startup to decide the mode before authenticating.
export const loadConfigRaw = async (): Promise<Config> => {
	const config = {
		mode: 'youtube',
		notifyOnFirstScan: true,
		...JSON.parse((await fs.readFile(CONFIG_FILE)).toString()),
	}
	if (config.initialBacklog !== undefined) {
		config.initialBacklog = parseBacklogPolicy(
			config.initialBacklog, 'initialBacklog')
	}
	if (config.videoRetentionDays !== undefined) {
		config.videoRetentionDays = parseVideoRetentionDays(
			config.videoRetentionDays)
	}
	if (config.emailSelectionPolicy !== undefined) {
		config.emailSelectionPolicy = parseEmailSelectionPolicy(
			config.emailSelectionPolicy)
	}
	return config
}

export const loadConfig = async (
	service?: youtube_v3.Youtube,
	auth?: OAuth2Client,
): Promise<Config> => {
	// This has to come here to avoid dependency loop
	const setupLogger = (await import('./lib/logger')).default
	const logger = await setupLogger({ label: 'config' })

	const normalizeChannel = normalizeChannelFactory(logger, service, auth)

	// Read general config and validate against the example schema.
	const general = await loadConfigRaw()
	validateConfig(general)
	const email = await loadEmailConfig()
	const channels = await updateJsonFile(CHANNELS_FILE, async value => {
		const lists = parseChannelLists(value)
		return {
			...lists,
			whitelistedChannelIds: await normalizeChannelEntries(
				normalizeChannel as (c: string) => Promise<string>,
				lists.whitelistedChannelIds),
			blacklistedChannelIds: await normalizeChannelEntries(
				normalizeChannel as (c: string) => Promise<string>,
				lists.blacklistedChannelIds),
			manualChannelIds: await normalizeChannelEntries(
				normalizeChannel as (c: string) => Promise<string>,
				lists.manualChannelIds),
		}
	})
	return {
		...general,
		email,
		whitelistedChannelIds: channels.whitelistedChannelIds,
		blacklistedChannelIds: channels.blacklistedChannelIds,
		manualChannelIds: channels.manualChannelIds,
		channelSettingsById:
			buildChannelSettingsMap(mergeChannelEntries([
				...(channels.whitelistedChannelIds ?? []),
				...(channels.manualChannelIds ?? []),
			])),
	}
}
