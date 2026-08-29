import { execFile } from 'node:child_process'

import { buildCodexInvocation } from '../../scheduler/codex-run-spec.mjs'
import { createCodexModelCatalog } from '../../scheduler/codex-model-catalog.mjs'
import { createCodexAppServerClient } from '../codex-app-server-client.mjs'
import { parseCodexJsonLine } from '../parsers/codex-jsonl.mjs'
import { runtimeError } from '../runtime-errors.mjs'
import { createCodexInteractiveSessionFactory } from './codex-interactive-session.mjs'

const CONVERSATION_PROTOCOL_BYTES = 4 * 1024 * 1024
const MAX_CONVERSATION_CHARACTERS = 1024 * 1024
const MAX_CONVERSATION_MESSAGES = 2_048

const FALLBACK_MODELS = Object.freeze([
  Object.freeze({
    id: 'default',
    displayName: 'Default (CLI config)',
    reasoningLevels: Object.freeze([]),
  }),
])

export function createCodexRuntimeDefinition({
  execFileImpl = execFile,
  clock,
  modelTtlMs,
  runtimeEnvironment,
  createAppServerClient = createCodexAppServerClient,
  interactiveFactory = null,
} = {}) {
  const modelCatalogs = new Map()
  const sessions = interactiveFactory ?? createCodexInteractiveSessionFactory({
    createClient: (options) => createAppServerClient({ ...options, runtimeEnvironment }),
  })

  function modelCatalog(executable) {
    let catalog = modelCatalogs.get(executable)
    if (!catalog) {
      catalog = createCodexModelCatalog({
        codexPath: executable,
        execFileImpl,
        ...(clock ? { clock } : {}),
        ...(modelTtlMs ? { ttlMs: modelTtlMs } : {}),
      })
      modelCatalogs.set(executable, catalog)
    }
    return catalog
  }

  return Object.freeze({
    id: 'codex',
    displayName: 'Codex',
    launch: Object.freeze({
      overrideEnv: 'CODEX_BIN',
      executableNames: Object.freeze(['codex']),
      packagedCandidates: Object.freeze([]),
      platformResolvers: Object.freeze(['codex-app']),
    }),
    versionProbe: Object.freeze({
      args: Object.freeze(['--version']),
      timeout_ms: 5_000,
    }),
    fallbackModels: FALLBACK_MODELS,
    streamFormat: 'codex-jsonl',
    parseEvent: parseCodexJsonLine,
    capabilities: Object.freeze({
      modelSelection: true,
      reasoning: true,
      sessionResume: true,
      sandbox: true,
      interactiveSession: true,
      conversationHistory: true,
    }),
    createInteractiveSession: (input) => sessions.create(input),
    async readConversation({ launch, run }) {
      const threadId = run?.session_id
      const workspace = run?.snapshot?.workspace
      if (typeof threadId !== 'string' || threadId.length === 0
        || typeof workspace !== 'string' || workspace.length === 0) {
        throw runtimeError(
          'RUNTIME_CONVERSATION_UNAVAILABLE',
          'The Run does not have a readable Codex session.',
        )
      }
      const client = createAppServerClient({
        executable: launch.executable,
        cwd: workspace,
        runtimeEnvironment,
        maximumLineBytes: CONVERSATION_PROTOCOL_BYTES,
      })
      try {
        await client.started
        await client.request('initialize', {
          clientInfo: { name: 'tasks-recorder', title: 'Tasks Recorder', version: 'source' },
        })
        const response = await client.request('thread/read', {
          threadId,
          includeTurns: true,
        })
        return normalizeConversation(response?.thread, threadId)
      } finally {
        client.close()
      }
    },
    async fetchModels({ launch }) {
      try {
        const models = await modelCatalog(launch.executable).list()
        return {
          source: 'live',
          models: models.map(normalizeModel),
        }
      } catch (error) {
        return {
          source: 'fallback',
          models: FALLBACK_MODELS,
          error_code: error?.code ?? 'MODEL_PROBE_FAILED',
        }
      }
    },
    async buildInvocation({ launch, run }) {
      return buildCodexInvocation(invocationSnapshot(run), {
        codexPath: launch.executable,
      })
    },
  })
}

function normalizeConversation(thread, expectedThreadId) {
  if (thread?.id !== expectedThreadId || !Array.isArray(thread.turns)) {
    throw runtimeError(
      'RUNTIME_CONVERSATION_UNAVAILABLE',
      'Codex did not return the requested session.',
    )
  }
  const messages = []
  let characters = 0
  let truncated = false
  for (const turn of thread.turns) {
    if (!Array.isArray(turn?.items)) continue
    for (const item of turn.items) {
      const message = conversationMessage(item)
      if (!message) continue
      messages.push(message)
      characters += message.text.length
      while (messages.length > MAX_CONVERSATION_MESSAGES
        || characters > MAX_CONVERSATION_CHARACTERS) {
        const removed = messages.shift()
        characters -= removed?.text.length ?? 0
        truncated = true
      }
    }
  }
  return {
    session_id: expectedThreadId,
    messages,
    truncated,
  }
}

function conversationMessage(item) {
  if (item?.type === 'userMessage' && Array.isArray(item.content)) {
    const text = item.content
      .filter((input) => input?.type === 'text' && typeof input.text === 'string')
      .map(({ text: value }) => value.trim())
      .filter(Boolean)
      .join('\n')
    return text ? { id: item.id, role: 'user', text } : null
  }
  if (item?.type === 'agentMessage' && typeof item.text === 'string') {
    const text = item.text.trim()
    return text ? { id: item.id, role: 'assistant', text } : null
  }
  return null
}

function invocationSnapshot(run) {
  if (Object.hasOwn(run, 'job_id')) return run
  return {
    job_id: run.id,
    definition_etag: run.etag,
    title: run.title,
    prompt: run.prompt,
    workspace: run.workspace,
    cadence: run.cadence,
    timezone_mode: run.timezone_mode ?? 'system',
    thread_mode: run.thread_mode ?? 'new',
    sandbox_mode: run.sandbox_mode,
    model: run.model ?? null,
    reasoning_effort: run.reasoning_effort ?? null,
    timeout_seconds: run.timeout_seconds,
  }
}

function normalizeModel(model) {
  return {
    id: model.slug,
    displayName: model.display_name,
    description: model.description,
    reasoningLevels: [...model.supported_reasoning_levels],
    defaultReasoningLevel: model.default_reasoning_level,
    metadata: {},
  }
}
