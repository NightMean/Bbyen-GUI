import process from 'process'
import readline from 'readline'

import authorize from './google/auth'
import { CONFIG_FILE, CHANNELS_FILE } from './config'
import { isChannelId } from './lib/channelId'
import { resolveChannelId } from './lib/resolveChannelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'

// A local readline that supports multiple sequential prompts (the shared
// google/auth/readline helper closes after a single question).
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
})
const ask = (question: string): Promise<string> =>
	new Promise(resolve => rl.question(question, resolve))

const writeMode = async (mode: 'youtube' | 'whitelist') => {
	await updateJsonFile(CONFIG_FILE, value => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('config.json must contain a JSON object.')
		}
		return { ...value, mode }
	}, { createIfMissing: true })
}

const main = async () => {
	const choice = (await ask(
		'Which mode?\n' +
		'  [1] YouTube login (auto-detect your subscriptions)\n' +
		'  [2] Whitelist-only (no login; you list the channels)\n' +
		'Enter 1 or 2: ')).trim()

	if (choice === '1') {
		await writeMode('youtube')
		rl.close()
		console.log('Mode set to "youtube". Starting login...')
		await authorize({ interactive: true })
		console.log('Setup complete. Run `npm start`.')
		process.exit(0)
	}

	if (choice === '2') {
		await writeMode('whitelist')
		console.log(
			'Mode set to "whitelist". Enter channel IDs (UC...), ' +
			'handles (@name), or URLs, one per line. Blank line to finish.')
		const ids: string[] = []
		for (;;) {
			const prompt = 'Channel ID, handle, or URL (or blank to finish): '
			const line = (await ask(prompt)).trim()
			if (!line) break
			try {
				const id = await resolveChannelId(line)
				ids.push(id)
				console.log(`  Added: ${id}`)
			} catch (err) {
				console.log(
					`  Could not resolve '${line}': ${(err as Error).message}`)
			}
		}
		rl.close()
		if (ids.length) {
			// Write to channels.json (create or merge).
			await updateJsonFile(CHANNELS_FILE, value => {
				const channels = parseChannelLists(value)
				return { ...channels, whitelistedChannelIds: mergeChannelEntries([
					...(channels.whitelistedChannelIds ?? []), ...ids,
				]) }
			}, { createIfMissing: true })
			console.log(`Wrote ${ids.length} channel(s) to channels.json.`)
		}
		console.log('Setup complete. Configure email, then run `npm start`.')
		process.exit(0)
	}

	console.log('Unrecognized choice. Run `npm run setup` again.')
	rl.close()
	process.exit(1)
}

main()
