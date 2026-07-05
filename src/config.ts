import process from 'process'
import axios from 'axios'
import path from 'path'
import fs from 'fs/promises'
import JSSoup from 'jssoup'
import winston from 'winston'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'

import deepEqual from './lib/deepEqual'
import configSchema from '../config.example.json'

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
}

export type RawChannelEntry = string | {
	id: string,
	notify?: boolean,
	notifyOnFirstScan?: boolean,
}

export interface Config {
	email: EmailConfig,
	port: number,
	database: {
		filename: string,
	},
	timers: {
		subscriptions: "2 days",
		videos: "20 minutes"
	},
	kickoff: {
		subscriptions: boolean,
		videos: boolean,
	},
	logging: {
		level: "error" | "warn" | "info" | "http" | "verbose" | "debug" | "silly",
		stackTraceLimit: number,
		emailOnError: boolean,
	},
	notifyOnFirstScan: boolean,
	whitelistedChannelIds?: ChannelEntry[],
	blacklistedChannelIds?: ChannelEntry[],
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

// Get the channel ID from the URL using the data API
export const normalizeChannelFactory = (
	logger: winston.Logger,
	service: youtube_v3.Youtube,
	auth: OAuth2Client,
) => async (channel: string) => {
	logger.verbose(`Normalizing channel string '${channel}'`)

	// If the string is already just the channel ID
	if (/^[0-9a-zA-Z_-]{24}$/.test(channel)) {
		return channel
	}

	// If the string is the channel URL with the ID built in
	const re = /^https:\/\/www.youtube.com\/channel\/([0-9a-zA-Z_-]{24})\/?$/
	const match = channel.match(re)
	if (match) {
		const id = match[1]
		logger.verbose(`String matches URL with ID: ${id}`)
		return id
	}

	// If it's the custom channel URL, try to get the ID from the API
	if (/^https:\/\/www.youtube.com\/(?:c\/|channel\/|)[^\/]*/.test(channel)) {
		logger.verbose('String matches URL with channel name')
		console.log('String matches URL with channel name')
		return await Promise.any([
			getChannelIdFromUrlAPI(service, auth, channel),
			getChannelIdFromUrlScrape(channel),
		])
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
): { user: string, pass: string } => {
	const user = process.env.BBYEN_EMAIL_USER ?? secrets?.email?.auth?.user
	const pass = process.env.BBYEN_EMAIL_PASS ?? secrets?.email?.auth?.pass
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
	return Promise.all(entries.map(async (entry) => {
		if (typeof entry === 'string') {
			return { id: await normalizeChannel(entry) }
		}
		return { ...entry, id: await normalizeChannel(entry.id) }
	}))
}

// Build an O(1) lookup keyed by channel id, containing only entries that carry
// a per-channel setting (notify or notifyOnFirstScan). Derived state, not
// persisted.
export const buildChannelSettingsMap = (
	entries: ChannelEntry[] | undefined,
): Map<string, ChannelEntry> => {
	const map = new Map<string, ChannelEntry>()
	for (const entry of entries ?? []) {
		if (entry.notify !== undefined ||
				entry.notifyOnFirstScan !== undefined) {
			map.set(entry.id, entry)
		}
	}
	return map
}

export const loadConfig = async (
	service: youtube_v3.Youtube,
	auth: OAuth2Client,
): Promise<Config> => {
	// This has to come here to avoid dependency loop
	const setupLogger = (await import('./lib/logger')).default
	const logger = await setupLogger({ label: 'config' })

	const normalizeChannel = normalizeChannelFactory(logger, service, auth)

	// Allow channel entries to be the URL or an object; normalize to
	// canonical ids and attach the lookup map.
	const normalizeConfig = async ({
		whitelistedChannelIds,
		blacklistedChannelIds,
		...config
	}: any): Promise<Config> => {
		const whitelist = await normalizeChannelEntries(
			normalizeChannel as (c: string) => Promise<string>,
			whitelistedChannelIds)
		const blacklist = await normalizeChannelEntries(
			normalizeChannel as (c: string) => Promise<string>,
			blacklistedChannelIds)
		return {
			...config,
			whitelistedChannelIds: whitelist,
			blacklistedChannelIds: blacklist,
			channelSettingsById: buildChannelSettingsMap(whitelist),
		}
	}

	// Read general config and validate against the example schema.
	const general = JSON.parse((await fs.readFile(CONFIG_FILE)).toString())
	validateConfig(general)

	// Read channels file (optional arrays inside).
	const channels = JSON.parse((await fs.readFile(CHANNELS_FILE)).toString())

	// Read secrets file if present; env vars may supply creds instead.
	let secrets: any = null
	try {
		secrets = JSON.parse((await fs.readFile(SECRETS_FILE)).toString())
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err
		}
	}
	const { user, pass } = resolveEmailCredentials(secrets)

	// Merge, inject credentials, normalize channel entries.
	const merged = {
		...general,
		email: { ...general.email, auth: { user, pass } },
		whitelistedChannelIds: channels.whitelistedChannelIds,
		blacklistedChannelIds: channels.blacklistedChannelIds,
	}
	const normalizedConfig = await normalizeConfig(merged)

	// Persist channel-id normalization back to channels.json if it changed
	// (e.g. URL entries rewritten to canonical ids).
	const normalizedChannels = {
		whitelistedChannelIds: normalizedConfig.whitelistedChannelIds,
		blacklistedChannelIds: normalizedConfig.blacklistedChannelIds,
	}
	if (!deepEqual(channels, normalizedChannels)) {
		await fs.writeFile(
			CHANNELS_FILE, JSON.stringify(normalizedChannels, null, '\t'))
	}

	return normalizedConfig
}
