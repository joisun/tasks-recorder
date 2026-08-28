import { execFile } from 'node:child_process'

import { buildCodexInvocation } from '../../scheduler/codex-run-spec.mjs'
import { createCodexModelCatalog } from '../../scheduler/codex-model-catalog.mjs'
import { createCodexAppServerClient } from '../codex-app-server-client.mjs'
import { parseCodexJsonLine } from '../parsers/codex-jsonl.mjs'
import { createCodexInteractiveSessionFactory } from './codex-interactive-session.mjs'

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
    }),
    createInteractiveSession: (input) => sessions.create(input),
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
