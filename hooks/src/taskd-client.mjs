import { resolveAppConfig } from '../../mcp/src/config.mjs'
import { createJournalEventClient } from './journal-client.mjs'

export async function sendJournalEvent(envelope, { projectRoot, env = process.env } = {}) {
  try {
    const config = await resolveAppConfig({ projectRoot, env })
    const client = createJournalEventClient({
      baseUrl: config.serverBaseUrl,
      spoolDirectory: config.spoolDirectory,
      spoolOptions: {
        maxBytes: config.spoolMaxBytes,
        maxFiles: config.spoolMaxFiles,
        maxAgeMs: config.spoolMaxAgeMs,
      },
    })
    return client.deliver(envelope)
  } catch {
    return {
      ok: true,
      delivered: false,
      spooled: false,
      dropped: true,
      error_code: 'JOURNAL_CLIENT_UNAVAILABLE',
    }
  }
}
