import authorize from './google/auth'
import setupLogger from './lib/logger'
import { version } from '../package.json'

// Standalone interactive re-authentication (youtube mode only).
const main = async () => {
	const args = process.argv.slice(2)
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`BBYEN ${version}\nUsage: npm run login -- [--manage]\n` +
			'--manage requests YouTube management access for unsubscribe.')
		return
	}
	if (args.includes('--version') || args.includes('-v')) {
		console.log(version)
		return
	}
	if (args.some(arg => arg !== '--manage')) {
		console.error('Unknown option. Use --help for supported options.')
		process.exitCode = 1
		return
	}
	const logger = await setupLogger({ label: 'login' })
	await authorize({ interactive: true, manage: args.includes('--manage') })
	logger.info('Authentication complete. You can now run `npm start`.')
}

main().catch(() => {
	console.error('Login failed. Check the account and try again.')
	process.exitCode = 1
})
