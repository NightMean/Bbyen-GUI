import process from 'process'
import readline from 'readline'

export default (
	question: string,
	signal?: AbortSignal,
): Promise<string> => new Promise((resolve, reject) => {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})
	const abort = () => {
		rl.close()
		reject(new Error('Login input cancelled.'))
	}
	if (signal?.aborted) return abort()
	signal?.addEventListener('abort', abort, { once: true })
	rl.question(question, answer => {
		signal?.removeEventListener('abort', abort)
		rl.close()
		resolve(answer)
	})
})
