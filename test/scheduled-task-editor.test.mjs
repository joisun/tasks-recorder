import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  cadenceVisibility,
  createScheduledTaskEditor,
  draftToPayload,
  normalizeDraft,
  revealFirstInvalidField,
  scheduledTaskEditorMarkup,
} from '../ui/src/scheduled-task-editor.mjs'

const ETAG = 'a'.repeat(64)
const MODEL_CATALOG = [
  {
    slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', description: 'Frontier agentic coding model.',
    default_reasoning_level: 'low',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', description: 'Fast coding model.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
]

test('Schedule Editor reveals the complete first invalid field after native validation scroll', () => {
  const scrollCalls = []
  const field = { scrollIntoView: (options) => scrollCalls.push(options) }
  const control = { closest: (selector) => selector === '.schedule-editor-field' ? field : null }
  const form = { querySelector: (selector) => selector === ':invalid' ? control : null }
  control.form = form
  const frames = []
  assert.equal(revealFirstInvalidField({ target: control }, (callback) => frames.push(callback)), true)
  assert.equal(scrollCalls.length, 0)
  frames[0]()
  assert.deepEqual(scrollCalls, [{ block: 'center', inline: 'nearest' }])
  assert.equal(revealFirstInvalidField({ target: { form, closest: () => field } }, () => assert.fail()), false)
})

function editorShell({ form = null } = {}) {
  const listeners = new Map()
  const focusTarget = { focus: () => undefined }
  const element = {
    hidden: true,
    innerHTML: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    querySelector: (selector) => selector === '[data-schedule-editor-form]' ? form : focusTarget,
    querySelectorAll: () => [],
  }
  const backdrop = {
    hidden: true,
    addEventListener: (type, listener) => listeners.set(`backdrop:${type}`, listener),
    removeEventListener: (type) => listeners.delete(`backdrop:${type}`),
  }
  return { element, backdrop, listeners }
}

class FormDataStub {
  constructor(form) {
    this.entriesList = Object.entries(form.values).flatMap(([key, value]) => (
      Array.isArray(value) ? value.map((item) => [key, item]) : [[key, value]]
    ))
  }

  get(name) {
    return this.entriesList.find(([key]) => key === name)?.[1] ?? null
  }

  getAll(name) {
    return this.entriesList.filter(([key]) => key === name).map(([, value]) => value)
  }

  [Symbol.iterator]() {
    return this.entriesList[Symbol.iterator]()
  }
}

test('Schedule Editor normalizes only safe Schedule fields with a read-only default', () => {
  assert.deepEqual(normalizeDraft({
    title: '  Morning review  ',
    prompt: '  inspect the open work  ',
    workspace: '  /workspace/review  ',
    cadence: { kind: 'weekly', weekdays: [5, 1, 1], hour: 9, minute: 15 },
    sandbox_mode: 'workspace-write',
    model: 'gpt-5.6-sol',
    reasoning_effort: 'ultra',
    timeout_seconds: 900,
    command: 'must never reach the browser',
    path: '/private/runner.sock',
  }), {
    title: 'Morning review',
    prompt: 'inspect the open work',
    workspace: '/workspace/review',
    agent: 'codex',
    cadenceKind: 'weekly',
    onceAt: '',
    minute: '15',
    hour: '9',
    weekdays: [1, 5],
    day: '1',
    sandbox_mode: 'workspace-write',
    dangerConfirmed: false,
    model: 'gpt-5.6-sol',
    reasoning_effort: 'ultra',
    timeout_seconds: '900',
  })
  assert.equal(normalizeDraft({}).sandbox_mode, 'read-only')
})

test('Schedule Editor converts drafts to the bounded API payload and cadence contract', () => {
  assert.deepEqual(draftToPayload({
    title: 'Daily brief',
    prompt: 'Summarize changes.',
    workspace: '/workspace/brief',
    agent: 'codex',
    cadenceKind: 'daily',
    hour: '8',
    minute: '5',
    sandbox_mode: 'read-only',
    model: '',
    reasoning_effort: '',
    timeout_seconds: '7200',
    command: 'not included',
    path: 'not included',
  }), {
    title: 'Daily brief',
    prompt: 'Summarize changes.',
    workspace: '/workspace/brief',
    agent: 'codex',
    cadence: { kind: 'daily', hour: 8, minute: 5, timezone_mode: 'system' },
    sandbox_mode: 'read-only',
    model: null,
    reasoning_effort: null,
    timeout_seconds: 7200,
  })

  assert.deepEqual(draftToPayload({
    title: 'Weekly review', prompt: 'Review.', workspace: '/workspace/review',
    cadenceKind: 'weekly', weekdays: [7, 2, 2], hour: 9, minute: 30,
    sandbox_mode: 'workspace-write', timeout_seconds: 300,
  }).cadence, {
    kind: 'weekly', weekdays: [2, 7], hour: 9, minute: 30, timezone_mode: 'system',
  })
})

test('Schedule Editor rejects unsafe and out-of-contract drafts before save', () => {
  const base = {
    title: 'Valid title', prompt: 'Valid prompt', workspace: '/workspace/valid',
    cadenceKind: 'hourly', minute: 10, sandbox_mode: 'read-only', timeout_seconds: 7200,
  }
  assert.throws(() => draftToPayload({ ...base, title: 'x'.repeat(201) }), /title/i)
  assert.throws(() => draftToPayload({ ...base, prompt: 'x'.repeat(20_001) }), /prompt/i)
  assert.throws(() => draftToPayload({ ...base, workspace: 'x'.repeat(4_097) }), /workspace/i)
  assert.throws(() => draftToPayload({ ...base, timeout_seconds: 59 }), /timeout_seconds/i)
  assert.throws(() => draftToPayload({
    ...base, sandbox_mode: 'danger-full-access', dangerConfirmed: false,
  }), /confirmation/i)
  assert.throws(() => draftToPayload({ ...base, model: '../unsafe' }), /model/i)
  assert.throws(() => draftToPayload({ ...base, reasoning_effort: 'HIGH!' }), /reasoning_effort/i)
  assert.throws(() => draftToPayload({
    ...base, model: 'gpt-5.6-luna', reasoning_effort: 'ultra',
  }, { modelCatalog: MODEL_CATALOG }), /reasoning_effort/i)
})

test('Schedule Editor exposes only the cadence controls for the selected kind', () => {
  assert.deepEqual(cadenceVisibility('once'), {
    once: true, hourly: false, daily: false, weekly: false, monthly: false, time: false,
  })
  assert.deepEqual(cadenceVisibility('hourly'), {
    once: false, hourly: true, daily: false, weekly: false, monthly: false, time: false,
  })
  assert.deepEqual(cadenceVisibility('weekly'), {
    once: false, hourly: false, daily: false, weekly: true, monthly: false, time: true,
  })
})

test('Schedule Editor CSS keeps inactive cadence controls out of layout', async () => {
  const css = await readFile(new URL('../ui/src/dashboard.css', import.meta.url), 'utf8')
  assert.match(css, /\.schedule-editor-field\[hidden\],\.schedule-editor-time\[hidden\],\.schedule-editor-weekdays\[hidden\]\{display:none\}/)
})

test('Schedule Editor markup has bounded fields, safety states, and no browser next-run calculation', () => {
  const markup = scheduledTaskEditorMarkup({
    mode: 'edit',
    state: 'conflict',
    error: 'Schedule 已被修改',
    draft: normalizeDraft({
      title: 'Danger <unsafe>', prompt: 'Prompt', workspace: '/workspace/review',
      cadence: { kind: 'monthly', day: 3, hour: 9, minute: 0 }, sandbox_mode: 'danger-full-access',
      model: 'gpt-5.6-sol', reasoning_effort: 'ultra',
    }),
    modelCatalog: MODEL_CATALOG,
    modelCatalogState: 'ready',
  })
  assert.match(markup, /data-schedule-editor-form/)
  assert.match(markup, /data-schedule-editor-state="conflict"/)
  assert.match(markup, /maxlength="200"/)
  assert.match(markup, /maxlength="20000"/)
  assert.match(markup, /maxlength="4096"/)
  assert.match(markup, /danger-full-access requires explicit confirmation/)
  assert.match(markup, /保存后由本机 Scheduler 计算/)
  assert.match(markup, /Schedule 已被修改/)
  assert.match(markup, /data-schedule-editor-action="delete"/)
  assert.doesNotMatch(markup, /<unsafe>/)
  assert.doesNotMatch(markup, /Next run preview|next_run_at|下一次运行预览/)
  assert.doesNotMatch(markup, /Schedule editor|New schedule|immutable Schedule spec|>Definition<|>Cadence<|>Runtime</)
  assert.match(markup, /GPT-5\.6-Sol/)
  assert.match(markup, /value="gpt-5\.6-sol" selected/)
  assert.match(markup, /value="ultra" selected/)
  assert.doesNotMatch(markup, /gpt-5-codex|gpt-5\.2-codex/)
})

test('Schedule Editor scopes reasoning choices to the selected model catalog entry', () => {
  const markup = scheduledTaskEditorMarkup({
    draft: {
      title: 'Luna job', prompt: 'Review.', workspace: '/workspace/review',
      cadenceKind: 'daily', model: 'gpt-5.6-luna', reasoning_effort: 'high',
    },
    modelCatalog: MODEL_CATALOG,
    modelCatalogState: 'ready',
  })
  assert.match(markup, /GPT-5\.6-Luna/)
  assert.match(markup, /value="max"/)
  assert.doesNotMatch(markup, /value="ultra"/)
})

test('Schedule Editor opens edit mode from an authoritative detail read, not a list-row prompt', async () => {
  const { element, backdrop } = editorShell()
  const seen = []
  const editor = createScheduledTaskEditor({
    element,
    backdrop,
    api: {
      schedule: async (id) => {
        seen.push(id)
        return {
          job: {
            id,
            etag: ETAG,
            title: 'Authoritative schedule',
            prompt: 'Authoritative Prompt detail',
            workspace: '/workspace/authoritative',
            cadence: { kind: 'daily', hour: 8, minute: 10 },
            sandbox_mode: 'read-only',
            timeout_seconds: 7200,
            command: 'browser must never receive this',
          },
        }
      },
      runtimes: async () => ({ runtimes: [{ id: 'codex', display_name: 'Codex' }] }),
      runtimeModels: async () => ({ models: MODEL_CATALOG }),
      createSchedule: async () => undefined,
      updateSchedule: async () => undefined,
      deleteSchedule: async () => undefined,
    },
  })

  await editor.openEdit('schedule-17', { trigger: null })
  assert.deepEqual(seen, ['schedule-17'])
  assert.equal(editor.isOpen(), true)
  assert.equal(element.hidden, false)
  assert.equal(backdrop.hidden, false)
  assert.match(element.innerHTML, /Authoritative Prompt detail/)
  assert.doesNotMatch(element.innerHTML, /browser must never receive this/)
})

test('Schedule Editor saves the bounded payload with the fetched etag, then refreshes the list', async () => {
  const form = {
    values: {
      title: 'Edited schedule', prompt: 'Use only this prompt.', workspace: '/workspace/edited',
      cadenceKind: 'weekly', hour: '7', minute: '45', weekdays: ['1', '4'],
      sandbox_mode: 'workspace-write', model: 'gpt-5.6-sol', reasoning_effort: 'medium', timeout_seconds: '600',
    },
    matches: (selector) => selector === '[data-schedule-editor-form]',
  }
  const { element, backdrop, listeners } = editorShell({ form })
  const updates = []
  let refreshes = 0
  const originalFormData = globalThis.FormData
  const originalDocument = globalThis.document
  globalThis.FormData = FormDataStub
  globalThis.document = { activeElement: null, querySelector: () => null }
  try {
    const editor = createScheduledTaskEditor({
      element,
      backdrop,
      api: {
        runtimes: async () => ({ runtimes: [{ id: 'codex', display_name: 'Codex' }] }),
        runtimeModels: async () => ({ models: MODEL_CATALOG }),
        schedule: async (id) => ({
          job: {
            id, etag: ETAG, title: 'Old title', prompt: 'Old prompt', workspace: '/workspace/old',
            cadence: { kind: 'daily', hour: 8, minute: 0 }, sandbox_mode: 'read-only', timeout_seconds: 7200,
          },
        }),
        createSchedule: async () => assert.fail('edit must not create a Schedule'),
        updateSchedule: async (...args) => updates.push(args),
        deleteSchedule: async () => assert.fail('edit must not delete a Schedule'),
      },
      onSaved: async () => { refreshes += 1 },
    })

    await editor.openEdit('schedule-12', { trigger: null })
    await listeners.get('submit')({ target: form, preventDefault: () => undefined })
    assert.equal(refreshes, 1)
    assert.equal(editor.isOpen(), false)
    assert.deepEqual(updates, [[
      'schedule-12', ETAG,
      {
        title: 'Edited schedule',
        prompt: 'Use only this prompt.',
        workspace: '/workspace/edited',
        agent: 'codex',
        cadence: { kind: 'weekly', hour: 7, minute: 45, timezone_mode: 'system', weekdays: [1, 4] },
        sandbox_mode: 'workspace-write',
        model: 'gpt-5.6-sol',
        reasoning_effort: 'medium',
        timeout_seconds: 600,
      },
    ]])
  } finally {
    globalThis.FormData = originalFormData
    globalThis.document = originalDocument
  }
})
