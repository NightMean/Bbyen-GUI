import {
	Config, buildChannelSettingsMap, normalizeChannelEntries,
} from './config'
import { assertChannelId } from './lib/channelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'

/** Preserve other writers' changes and settings when adding a channel. */
export const addManualChannel = async (
	filename: string, config: Config, channelId: string,
): Promise<void> => {
	assertChannelId(channelId)
	const lists = await updateJsonFile(filename, async value => {
		const current = parseChannelLists(value)
		// Startup normalizes this file; revalidate after another writer changes it.
		const normalize = async (id: string) => assertChannelId(id)
		const whitelist = await normalizeChannelEntries(normalize,
			current.whitelistedChannelIds) ?? []
		const blacklist = await normalizeChannelEntries(normalize,
			current.blacklistedChannelIds)
		const manual = await normalizeChannelEntries(normalize,
			current.manualChannelIds) ?? []
		return { ...current,
			whitelistedChannelIds: mergeChannelEntries([...whitelist, channelId]),
			blacklistedChannelIds: blacklist,
			manualChannelIds: mergeChannelEntries([...manual, channelId]),
		}
	})
	config.whitelistedChannelIds = lists.whitelistedChannelIds
	config.blacklistedChannelIds = lists.blacklistedChannelIds
	config.manualChannelIds = lists.manualChannelIds
	config.channelSettingsById = buildChannelSettingsMap(mergeChannelEntries([
		...lists.whitelistedChannelIds, ...lists.manualChannelIds,
	]))
}
