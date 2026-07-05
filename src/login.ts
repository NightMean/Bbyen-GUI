import authorize from './google/auth'
import setupLogger from './lib/logger'

// Standalone interactive re-authentication (youtube mode only).
const main = async () => {
	const logger = await setupLogger({ label: 'login' })
	await authorize({ interactive: true })
	logger.info('Authentication complete. You can now run `npm start`.')
	process.exit(0)
}

main()
