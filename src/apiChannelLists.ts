import fs from 'fs/promises'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import {
	Config, buildChannelSettingsMap, normalizeChannelEntries,
} from './config'
import { assertChannelId } from './lib/channelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'

export type ApiChannelList = 'allowlist' | 'blocklist'

export const normalizeApiChannelLists = async (value: unknown) => {
	const lists = parseChannelLists(value)
	const normalize = async (id: string) => assertChannelId(id)
	return { ...lists,
		whitelistedChannelIds: await normalizeChannelEntries(normalize,
			lists.whitelistedChannelIds),
		blacklistedChannelIds: await normalizeChannelEntries(normalize,
			lists.blacklistedChannelIds),
		manualChannelIds: await normalizeChannelEntries(normalize,
			lists.manualChannelIds),
		savedChannelSettings: await normalizeChannelEntries(normalize,
			lists.savedChannelSettings),
	}
}

export const applyApiChannelLists = (config: Config,
	lists: Awaited<ReturnType<typeof normalizeApiChannelLists>>) => {
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

type NormalizedLists = Awaited<ReturnType<typeof normalizeApiChannelLists>>

const updateApiLists = async (filename: string, config: Config,
	update: (lists: NormalizedLists) => NormalizedLists): Promise<void> => {
	try {
		const updated = await updateJsonFile(filename, async value =>
			update(await normalizeApiChannelLists(value)))
		applyApiChannelLists(config, updated)
	} catch (error) {
		// The replacement can succeed before cleanup reports an error.
		try { applyApiChannelLists(config, await normalizeApiChannelLists(
			JSON.parse(await fs.readFile(filename, 'utf8')))) }
		catch { /* Keep the original failure and current runtime state. */ }
		throw error
	}
}

/** Update email selection only; never alter YouTube membership or the bell. */
export const setApiChannelList = async (db: sqlite.Database, filename: string,
	config: Config, channelId: string, list: ApiChannelList, included: boolean,
): Promise<void> => {
	assertChannelId(channelId)
	if (config.mode !== 'youtube' || !config.emailSelectionPolicy ||
			!['allowlist', 'blocklist'].includes(list) ||
			typeof included !== 'boolean') {
		throw new Error('List control unavailable.')
	}
	const exists = await db.get(SQL`SELECT 1 FROM subscriptions
		WHERE channelId=${channelId};`)
	if (!exists) {
		throw new Error('Channel not found.')
	}
	await updateApiLists(filename, config, lists => {
		const key = list === 'allowlist' ? 'whitelistedChannelIds' :
			'blacklistedChannelIds'
		const entries = lists[key]
		const effective = mergeChannelEntries([
			...(lists.savedChannelSettings ?? []),
			...(lists.whitelistedChannelIds ?? []),
			...(lists.manualChannelIds ?? []),
		]).find(entry => entry.id === channelId)
		const savedChannelSettings = list === 'allowlist' && !included &&
				effective ? mergeChannelEntries([
				...(lists.savedChannelSettings ?? []), effective,
			])
			: lists.savedChannelSettings
		return { ...lists, savedChannelSettings, [key]: included
			? mergeChannelEntries([...(entries ?? []), { id: channelId }])
			: entries?.filter(entry => entry.id !== channelId) }
	})
}

/** Stop manual tracking while leaving both email lists and YouTube intact. */
export const removeApiManualChannel = async (filename: string, config: Config,
	channelId: string): Promise<void> => {
	assertChannelId(channelId)
	if (config.mode !== 'youtube' || !config.emailSelectionPolicy) {
		throw new Error('API manual tracking is unavailable.')
	}
	await updateApiLists(filename, config, lists => {
		if (!lists.manualChannelIds?.some(entry => entry.id === channelId)) {
			throw new Error('Channel is not manually tracked.')
		}
		const effective = mergeChannelEntries([
			...(lists.savedChannelSettings ?? []),
			...(lists.whitelistedChannelIds ?? []),
			...(lists.manualChannelIds ?? []),
		]).find(entry => entry.id === channelId)
		return { ...lists,
			manualChannelIds: lists.manualChannelIds.filter(c => c.id !== channelId),
			savedChannelSettings: effective ? mergeChannelEntries([
				...(lists.savedChannelSettings ?? []), effective,
			]) : lists.savedChannelSettings,
		}
	})
}
