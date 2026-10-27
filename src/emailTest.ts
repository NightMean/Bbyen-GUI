import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'

/** Record the attempt before sending; ambiguous results are never replayed. */
export const sendTestEmail = async (
	db: sqlite.Database, send: () => Promise<unknown>,
): Promise<'sent' | 'uncertain'> => {
	const id = randomUUID()
	await db.run(SQL`INSERT INTO email_test_runs (id, startedAt, outcome)
		VALUES (${id}, ${new Date().toISOString()}, 'pending');`)
	let outcome: 'sent' | 'uncertain' = 'uncertain'
	try { await send(); outcome = 'sent' } catch {
		// A lost SMTP acknowledgement may mean the message was delivered.
	}
	await db.run(SQL`UPDATE email_test_runs SET outcome=${outcome},
		finishedAt=${new Date().toISOString()} WHERE id=${id};`)
	try {
		await db.run(`DELETE FROM email_test_runs WHERE outcome <> 'pending'
			AND id NOT IN (SELECT id FROM email_test_runs
			ORDER BY rowid DESC LIMIT 1000)`)
	} catch { console.warn('Could not prune test-email history.') }
	return outcome
}
