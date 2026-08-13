const MAX_STDIN_BYTES = 1024 * 1024

export function dynamicContext(input) {
  return {
    session_id: input?.session_id ?? null,
    workfolder: input?.cwd ?? null,
    agent: 'Claude',
  }
}

export async function readHookInput(stream = process.stdin) {
  const chunks = []
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > MAX_STDIN_BYTES) throw new Error('hook input exceeds 1 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
