// A YouTube channel ID is "UC" followed by 22 URL-safe base64 characters.
const CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{22}$/

export const isChannelId = (value: string): boolean =>
	CHANNEL_ID_RE.test(value)

// Return the value if it is a raw channel ID, otherwise throw. Whitelist mode
// has no API to resolve URLs/handles, so it requires raw IDs.
export const assertChannelId = (value: string): string => {
	if (!isChannelId(value)) {
		throw new Error(
			`'${value}' is not a raw channel ID. In whitelist mode, ` +
			'whitelistedChannelIds must be 24-character IDs starting with "UC".')
	}
	return value
}
