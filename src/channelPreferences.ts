import fs from 'fs/promises'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import {
	ChannelEntry, Config, buildChannelSettingsMap, normalizeChannelEntries,
} from './config'
import { assertChannelId } from './lib/channelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'

/** Save a local email preference without changing the YouTube subscription. */
export const setCookieChannelNotify = async (db: sqlite.Database,
	filename: string, config: Config, channelId: string, notify: boolean,
): Promise<void> => {
	assertChannelId(channelId)
	if (config.mode !== 'cookie') throw new Error('Cookie mode required.')
	const subscribed = await db.get(SQL`SELECT 1 FROM cookie_channel_state s
		JOIN cookie_connection c ON c.channelId=s.profileKey
		WHERE c.id=1 AND s.channelId=${channelId} AND s.subscribed=1;`)
	if (!subscribed) throw new Error('Channel is not a confirmed subscription.')
	await saveChannelNotify(filename, config, channelId, notify)
}

export const setApiChannelNotify = async (db: sqlite.Database,
	filename: string, config: Config, channelId: string, notify: boolean,
): Promise<void> => {
	assertChannelId(channelId)
	if (config.mode !== 'youtube') throw new Error('API mode required.')
	const tracked = await db.get(SQL`SELECT 1 FROM subscriptions
		WHERE channelId=${channelId} AND deleted=0;`)
	if (!tracked) throw new Error('Channel is not currently tracked.')
	await saveChannelNotify(filename, config, channelId, notify)
}

const saveChannelNotify = async (filename: string, config: Config,
	channelId: string, notify: boolean): Promise<void> => {
	const apply = (lists: { whitelistedChannelIds?: ChannelEntry[],
		blacklistedChannelIds?: ChannelEntry[], manualChannelIds?: ChannelEntry[],
		savedChannelSettings?: ChannelEntry[] }) => {
		config.whitelistedChannelIds = lists.whitelistedChannelIds
		config.blacklistedChannelIds = lists.blacklistedChannelIds
		config.manualChannelIds = lists.manualChannelIds
		config.savedChannelSettings = lists.savedChannelSettings
		config.channelSettingsById = buildChannelSettingsMap(mergeChannelEntries([
			...(lists.savedChannelSettings ?? []),
			...(lists.whitelistedChannelIds ?? []),
			...(lists.manualChannelIds ?? []),
		]))
	}
	try {
		const lists = await updateJsonFile(filename, async value => {
			const current = parseChannelLists(value)
			const normalize = async (id: string) => assertChannelId(id)
			const whitelist = await normalizeChannelEntries(normalize,
				current.whitelistedChannelIds)
			const blacklist = await normalizeChannelEntries(normalize,
				current.blacklistedChannelIds)
			const manual = await normalizeChannelEntries(normalize,
				current.manualChannelIds)
			const saved = await normalizeChannelEntries(normalize,
				current.savedChannelSettings) ?? []
			const updateExisting = (entries: typeof whitelist) =>
				entries?.map(entry => entry.id === channelId
					? { ...entry, notify } : entry)
			return { ...current, whitelistedChannelIds: updateExisting(whitelist),
				blacklistedChannelIds: blacklist,
				manualChannelIds: updateExisting(manual),
				savedChannelSettings: mergeChannelEntries([
					...saved, { id: channelId, notify },
				]) }
		})
		apply(lists)
	} catch (error) {
		// An atomic replacement can succeed before lock cleanup reports failure.
		// Re-read the authoritative file so the live service follows that result.
		try {
			const raw = parseChannelLists(JSON.parse(
				await fs.readFile(filename, 'utf8')))
			const normalize = async (id: string) => assertChannelId(id)
			apply({
				whitelistedChannelIds: await normalizeChannelEntries(normalize,
					raw.whitelistedChannelIds),
				blacklistedChannelIds: await normalizeChannelEntries(normalize,
					raw.blacklistedChannelIds),
				manualChannelIds: await normalizeChannelEntries(normalize,
					raw.manualChannelIds),
				savedChannelSettings: await normalizeChannelEntries(normalize,
					raw.savedChannelSettings),
			})
		} catch { /* Keep the original failure and existing runtime state. */ }
		throw error
	}
}
