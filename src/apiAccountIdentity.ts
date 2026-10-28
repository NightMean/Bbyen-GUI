import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { Config } from './config'
import { isChannelId } from './lib/channelId'
import { readAccountIdentity } from './google/accountIdentity'
import { withAuthorizationTimeout } from './google/desktopAuthorization'

/** Bind API operations to the account owning the subscription list. */
export class ApiAccountIdentity {
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly service: youtube_v3.Youtube,
		private readonly loadAuth: () => Promise<OAuth2Client>,
		private readonly revision: () => Promise<string>) {}

	async stored(): Promise<string | null> {
		const row = await this.db.get('SELECT channelId FROM api_account_identity')
		if (!row) return null
		if (!isChannelId(row.channelId)) throw new Error('Invalid saved account.')
		return row.channelId
	}

	async verify(auth: OAuth2Client): Promise<string> {
		if (this.config.mode !== 'youtube') throw new Error('API mode changed.')
		const revision = await this.revision()
		const identity = await withAuthorizationTimeout(
			readAccountIdentity(this.service, auth))
		if (this.config.mode !== 'youtube' || revision !== await this.revision()) {
			throw new Error('Authorization changed during account verification.')
		}
		await this.db.run(SQL`INSERT INTO api_account_identity (id, channelId)
			VALUES (1, ${identity.channelId}) ON CONFLICT(id) DO NOTHING;`)
		if (await this.stored() !== identity.channelId) {
			throw new Error('Google account does not match the saved API account.')
		}
		return identity.channelId
	}

	async expected(): Promise<string> {
		const stored = await this.stored()
		if (stored) return stored
		const revision = await this.revision()
		const auth = await this.loadAuth()
		if (revision !== await this.revision()) {
			throw new Error('Authorization changed during account verification.')
		}
		return this.verify(auth)
	}
}
