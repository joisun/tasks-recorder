import { resolveAppConfig } from '../../mcp/src/config.mjs'
import { createTaskClient } from '../../mcp/src/task-client.mjs'

export async function sendHeartbeat(input, { projectRoot, env = process.env } = {}) {
  const config = await resolveAppConfig({ projectRoot, env })
  const client = createTaskClient({
    baseUrl: config.serverBaseUrl,
    timeoutMs: 1_000,
  })
  return client.heartbeat(input)
}
