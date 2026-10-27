import { ErrorCategory } from './lib/classifyError'

export interface RefreshResult {
	status: 'success' | 'partial' | 'failed',
	total: number | null,
	succeeded: number,
	failed: number,
	skipped: number,
	failedChannels: string[],
	failedChannelsTruncated?: boolean,
	errorCategory?: ErrorCategory,
	apiChecked?: boolean,
}
