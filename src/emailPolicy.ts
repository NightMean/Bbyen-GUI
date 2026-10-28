import type { ChannelEntry, Config } from './config'

export type EmailSelectionPolicy = 'allowlist' | 'blocklist'
export type EmailEligibility = 'eligible' | 'muted' | 'excluded'

export const parseEmailSelectionPolicy = (
	value: unknown,
): EmailSelectionPolicy => {
	if (value === 'allowlist' || value === 'blocklist') return value
	throw new Error('emailSelectionPolicy must be allowlist or blocklist.')
}

export const makeEmailEligibility = (
	config: Pick<Config, 'mode' | 'emailSelectionPolicy' |
		'whitelistedChannelIds' | 'blacklistedChannelIds'>,
	manualOnly: ReadonlySet<string> = new Set(),
): (channelId: string, entry?: ChannelEntry) => EmailEligibility => {
	const allow = new Set(config.whitelistedChannelIds?.map(item => item.id) ??
		[])
	const block = new Set(config.blacklistedChannelIds?.map(item => item.id) ??
		[])
	return (channelId, entry) => {
		if (entry?.notify === false) return 'muted'
		if (config.mode === 'whitelist' && entry?.manualPolicyExcluded) {
			return 'muted'
		}
		if (config.mode !== 'youtube' || !config.emailSelectionPolicy) {
			return 'eligible'
		}
		if (block.has(channelId)) return 'excluded'
		if (manualOnly.has(channelId)) return 'eligible'
		if (config.emailSelectionPolicy === 'allowlist' && !allow.has(channelId)) {
			return 'excluded'
		}
		return 'eligible'
	}
}
