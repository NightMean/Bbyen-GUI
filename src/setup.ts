import process from 'process'
import readline from 'readline'
import fs from 'fs/promises'

import authorize from './google/auth'
import { CONFIG_FILE } from './config'
import { isChannelId } from './lib/channelId'

// A local readline that supports multiple sequential prompts (the shared
// google/auth/readline helper closes after a single question).
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
})
const ask = (question: string): Promise<string> =>
	new Promise(resolve => rl.question(question, resolve))

const readConfig = async (): Promise<Record<string, unknown>> => {
	try {
		return JSON.parse((await fs.readFile(CONFIG_FILE)).toString())
	} catch {
		return {}
	}
}

const writeMode = async (mode: 'youtube' | 'whitelist') => {
	const config = await readConfig()
	config.mode = mode
	await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, '\t'))
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
			'Mode set to "whitelist". Enter channel IDs (UC...), one per line. ' +
			'Blank line to finish.')
		const ids: string[] = []
		for (;;) {
			const line = (await ask('Channel ID (or blank to finish): ')).trim()
			if (!line) break
			if (isChannelId(line)) {
				ids.push(line)
			} else {
				console.log(`  Ignored '${line}': not a 24-char UC channel ID.`)
			}
		}
		rl.close()
		if (ids.length) {
			// Write to channels.json (create or merge).
			const channelsFile = CONFIG_FILE.replace(
				/config\.json$/, 'channels.json')
			let channels: { whitelistedChannelIds?: string[] } = {}
			try {
				channels = JSON.parse(
					(await fs.readFile(channelsFile)).toString())
			} catch {
				channels = {}
			}
			channels.whitelistedChannelIds = [
				...(channels.whitelistedChannelIds ?? []), ...ids,
			]
			await fs.writeFile(
				channelsFile, JSON.stringify(channels, null, '\t'))
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
