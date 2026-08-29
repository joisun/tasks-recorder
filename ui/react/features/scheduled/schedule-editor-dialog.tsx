import { AlertTriangle, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Modal, ModalOverlay } from 'react-aria-components/Modal'

import { Button } from '@/components/ui/button'
import {
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input, TextArea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DashboardApiError, type DashboardApi } from '@/lib/api/dashboard-api'
import type { RuntimeStatus, ScheduleRecord } from '@/lib/api/types'
import {
  defaultScheduleDraft,
  draftToScheduleInput,
  normalizeModelCatalog,
  scheduleToDraft,
  type CadenceKind,
  type ModelOption,
  type ScheduleDraft,
} from './schedule-draft'

const WEEKDAYS = [
  [1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [7, '日'],
] as const

type EditorPhase = 'loading' | 'ready' | 'saving' | 'deleting'
type CatalogState = 'loading' | 'ready' | 'error'

function editorError(error: unknown) {
  if (error instanceof DashboardApiError && error.code === 'SCHEDULE_VERSION_CONFLICT') {
    return 'Schedule 已在其他位置更新。当前输入已保留，请关闭后重新打开以载入最新版本。'
  }
  return error instanceof Error ? error.message : 'Schedule 保存失败'
}

function systemTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'System' } catch { return 'System' }
}

function FieldLabel({ children, htmlFor }: { children: string; htmlFor?: string }) {
  return htmlFor
    ? <label className="schedule-editor__label" htmlFor={htmlFor}>{children}</label>
    : <span className="schedule-editor__label">{children}</span>
}

export function ScheduleEditorDialog({
  api,
  open,
  schedule,
  onOpenChange,
  onSaved,
}: {
  api: DashboardApi
  open: boolean
  schedule: ScheduleRecord | null
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(defaultScheduleDraft)
  const [phase, setPhase] = useState<EditorPhase>('ready')
  const [error, setError] = useState('')
  const [etag, setEtag] = useState<string | null>(null)
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [catalog, setCatalog] = useState<ModelOption[]>([])
  const [catalogState, setCatalogState] = useState<CatalogState>('loading')
  const [deleteArmed, setDeleteArmed] = useState(false)
  const editing = Boolean(schedule)
  const busy = phase !== 'ready'

  useEffect(() => {
    if (!open) return undefined
    let canceled = false
    setPhase(schedule ? 'loading' : 'ready')
    setDraft(defaultScheduleDraft())
    setEtag(null)
    setError('')
    setDeleteArmed(false)
    setCatalog([])
    setCatalogState('loading')

    void (async () => {
      let nextDraft = defaultScheduleDraft()
      let nextRuntimes: RuntimeStatus[]
      try {
        const [runtimeResponse, scheduleResponse] = await Promise.all([
          api.runtimes(),
          schedule ? api.schedule(schedule.id) : Promise.resolve(null),
        ])
        nextRuntimes = runtimeResponse.runtimes
        if (!Array.isArray(nextRuntimes) || !nextRuntimes.length) throw new TypeError('Runtime registry 为空')
        if (scheduleResponse) {
          nextDraft = scheduleToDraft(scheduleResponse.job)
          if (!/^[0-9a-f]{64}$/.test(scheduleResponse.job.etag)) throw new TypeError('Schedule etag 无效')
          if (!canceled) setEtag(scheduleResponse.job.etag)
        } else if (!nextRuntimes.some(({ id }) => id === nextDraft.agent)) {
          nextDraft.agent = nextRuntimes[0].id
        }
      } catch (caught) {
        if (canceled) return
        if (schedule) {
          setPhase('ready')
          setError(caught instanceof Error ? caught.message : '无法读取 Schedule')
          setCatalogState('error')
          return
        }
        nextRuntimes = [{ id: 'codex', display_name: 'Codex', state: 'unavailable' }]
      }
      if (canceled) return
      if (!nextRuntimes.some(({ id }) => id === nextDraft.agent)) {
        nextRuntimes = [...nextRuntimes, {
          id: nextDraft.agent,
          display_name: `${nextDraft.agent} · unavailable`,
          state: 'unavailable',
        }]
      }
      setRuntimes(nextRuntimes)
      setDraft(nextDraft)
      setPhase('ready')
      try {
        const response = await api.runtimeModels(nextDraft.agent)
        const models = normalizeModelCatalog(response.models)
        if (!canceled) {
          setCatalog(models)
          setCatalogState('ready')
        }
      } catch {
        if (!canceled) setCatalogState('error')
      }
    })()
    return () => { canceled = true }
  }, [api, open, schedule?.id])

  const reasoningLevels = useMemo(() => {
    const selected = catalog.find(({ slug }) => slug === draft.model)
    return selected
      ? selected.reasoningLevels
      : [...new Set(catalog.flatMap(({ reasoningLevels: levels }) => levels))]
  }, [catalog, draft.model])

  function update<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setError('')
    setDeleteArmed(false)
  }

  async function changeAgent(agent: string) {
    update('agent', agent)
    setDraft((current) => ({ ...current, agent, model: '', reasoning_effort: '' }))
    setCatalog([])
    setCatalogState('loading')
    try {
      const response = await api.runtimeModels(agent)
      setCatalog(normalizeModelCatalog(response.models))
      setCatalogState('ready')
    } catch {
      setCatalogState('error')
    }
  }

  async function save() {
    if (busy) return
    let payload
    try {
      payload = draftToScheduleInput(draft, { modelCatalog: catalog })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '输入无效')
      return
    }
    setPhase('saving')
    setError('')
    try {
      if (schedule) {
        if (!etag) throw new TypeError('Schedule etag 不可用')
        await api.updateSchedule(schedule.id, etag, payload)
      } else {
        await api.createSchedule(payload)
      }
      await onSaved()
      onOpenChange(false)
    } catch (caught) {
      setError(editorError(caught))
      setPhase('ready')
    }
  }

  async function remove() {
    if (!schedule || !etag || busy) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    setPhase('deleting')
    setError('')
    try {
      await api.deleteSchedule(schedule.id, etag)
      await onSaved()
      onOpenChange(false)
    } catch (caught) {
      setError(editorError(caught))
      setPhase('ready')
    }
  }

  const catalogNote = catalogState === 'loading'
    ? '正在读取本机 Runtime model catalog…'
    : catalogState === 'error'
      ? 'Model catalog 当前不可用；可以使用 Runtime default。'
      : (catalog.find(({ slug }) => slug === draft.model)?.description
          || 'Model 与 Reasoning 来自本机 Agent CLI。')

  return (
    <ModalOverlay
      className="schedule-editor-overlay"
      isDismissable={!busy}
      isOpen={open}
      onOpenChange={onOpenChange}
    >
      <Modal className="schedule-editor-modal">
        <DialogContent className="schedule-editor-dialog" showCloseButton={!busy}>
          <DialogHeader className="schedule-editor__header">
            <DialogTitle>{editing ? '编辑计划' : '新建计划'}</DialogTitle>
            <p>保存后写入 Markdown definition，taskd watcher 会自动同步。</p>
          </DialogHeader>

          <DialogBody className="schedule-editor__body">
            {phase === 'loading' ? <div className="schedule-editor__loading" aria-busy="true">正在读取 Schedule…</div> : (
              <form id="schedule-editor-form" className="schedule-editor__form" onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}>
                {error ? <div className="schedule-editor__error" role="alert">{error}</div> : null}

                <section className="schedule-editor__section">
                  <h3>任务</h3>
                  <div className="schedule-editor__field">
                    <FieldLabel htmlFor="schedule-title">Title</FieldLabel>
                    <Input autoFocus disabled={busy} id="schedule-title" maxLength={200} required size="sm" value={draft.title} onChange={(event) => update('title', event.currentTarget.value)} />
                  </div>
                  <div className="schedule-editor__field">
                    <FieldLabel htmlFor="schedule-prompt">Prompt</FieldLabel>
                    <TextArea disabled={busy} id="schedule-prompt" maxLength={20_000} required value={draft.prompt} onChange={(event) => update('prompt', event.currentTarget.value)} />
                  </div>
                  <div className="schedule-editor__field">
                    <FieldLabel htmlFor="schedule-workspace">Workspace</FieldLabel>
                    <Input disabled={busy} id="schedule-workspace" maxLength={4_096} required size="sm" value={draft.workspace} onChange={(event) => update('workspace', event.currentTarget.value)} />
                  </div>
                </section>

                <section className="schedule-editor__section">
                  <div className="schedule-editor__section-title">
                    <h3>执行时间</h3><span>{systemTimezone()}</span>
                  </div>
                  <div className="schedule-editor__field">
                    <FieldLabel>Repeat</FieldLabel>
                    <Select aria-label="Repeat" isDisabled={busy} selectedKey={draft.cadenceKind} onSelectionChange={(key) => update('cadenceKind', String(key) as CadenceKind)}>
                      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem id="once">Once</SelectItem><SelectItem id="hourly">Hourly</SelectItem>
                        <SelectItem id="daily">Daily</SelectItem><SelectItem id="weekly">Weekly</SelectItem>
                        <SelectItem id="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {draft.cadenceKind === 'once' ? (
                    <div className="schedule-editor__field"><FieldLabel htmlFor="schedule-once">Date and time</FieldLabel><Input disabled={busy} id="schedule-once" type="datetime-local" value={draft.onceAt} onChange={(event) => update('onceAt', event.currentTarget.value)} /></div>
                  ) : null}
                  {draft.cadenceKind === 'hourly' ? (
                    <div className="schedule-editor__field"><FieldLabel htmlFor="schedule-minute">Minute past each hour</FieldLabel><Input disabled={busy} id="schedule-minute" max={59} min={0} type="number" value={draft.minute} onChange={(event) => update('minute', event.currentTarget.value)} /></div>
                  ) : null}
                  {['daily', 'weekly', 'monthly'].includes(draft.cadenceKind) ? (
                    <div className="schedule-editor__inline">
                      <div className="schedule-editor__field"><FieldLabel htmlFor="schedule-hour">Hour</FieldLabel><Input disabled={busy} id="schedule-hour" max={23} min={0} type="number" value={draft.hour} onChange={(event) => update('hour', event.currentTarget.value)} /></div>
                      <div className="schedule-editor__field"><FieldLabel htmlFor="schedule-clock-minute">Minute</FieldLabel><Input disabled={busy} id="schedule-clock-minute" max={59} min={0} type="number" value={draft.minute} onChange={(event) => update('minute', event.currentTarget.value)} /></div>
                    </div>
                  ) : null}
                  {draft.cadenceKind === 'weekly' ? (
                    <div className="schedule-editor__weekdays" role="group" aria-label="Weekly days">
                      {WEEKDAYS.map(([day, label]) => <label key={day}><input checked={draft.weekdays.includes(day)} disabled={busy} type="checkbox" onChange={(event) => update('weekdays', event.currentTarget.checked ? [...draft.weekdays, day] : draft.weekdays.filter((value) => value !== day))} /><span>{label}</span></label>)}
                    </div>
                  ) : null}
                  {draft.cadenceKind === 'monthly' ? (
                    <div className="schedule-editor__field"><FieldLabel htmlFor="schedule-day">Day of month</FieldLabel><Input disabled={busy} id="schedule-day" max={31} min={1} type="number" value={draft.day} onChange={(event) => update('day', event.currentTarget.value)} /></div>
                  ) : null}
                </section>

                <section className="schedule-editor__section">
                  <h3>Runtime</h3>
                  <div className="schedule-editor__grid">
                    <div className="schedule-editor__field"><FieldLabel>Agent</FieldLabel><Select aria-label="Agent" isDisabled={busy} selectedKey={draft.agent} onSelectionChange={(key) => void changeAgent(String(key))}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{runtimes.map((runtime) => <SelectItem id={runtime.id} key={runtime.id}>{runtime.display_name}</SelectItem>)}</SelectContent></Select></div>
                    <div className="schedule-editor__field"><FieldLabel>Sandbox</FieldLabel><Select aria-label="Sandbox" isDisabled={busy} selectedKey={draft.sandbox_mode} onSelectionChange={(key) => update('sandbox_mode', String(key) as ScheduleRecord['sandbox_mode'])}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem id="read-only">read-only</SelectItem><SelectItem id="workspace-write">workspace-write</SelectItem><SelectItem id="danger-full-access">danger-full-access</SelectItem></SelectContent></Select></div>
                    <div className="schedule-editor__field"><FieldLabel>Model</FieldLabel><Select aria-label="Model" isDisabled={busy || catalogState !== 'ready'} selectedKey={draft.model || 'default'} onSelectionChange={(key) => { const model = String(key) === 'default' ? '' : String(key); const selected = catalog.find(({ slug }) => slug === model); setDraft((current) => ({ ...current, model, reasoning_effort: selected && current.reasoning_effort && !selected.reasoningLevels.includes(current.reasoning_effort) ? '' : current.reasoning_effort })); setError('') }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem id="default">Runtime default</SelectItem>{catalog.map((model) => <SelectItem id={model.slug} key={model.slug}>{model.displayName} · {model.slug}</SelectItem>)}</SelectContent></Select></div>
                    <div className="schedule-editor__field"><FieldLabel>Reasoning</FieldLabel><Select aria-label="Reasoning" isDisabled={busy || catalogState !== 'ready'} selectedKey={draft.reasoning_effort || 'default'} onSelectionChange={(key) => update('reasoning_effort', String(key) === 'default' ? '' : String(key))}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem id="default">Runtime default</SelectItem>{reasoningLevels.map((level) => <SelectItem id={level} key={level}>{level}</SelectItem>)}</SelectContent></Select></div>
                    <div className="schedule-editor__field"><FieldLabel htmlFor="schedule-timeout">Timeout (seconds)</FieldLabel><Input disabled={busy} id="schedule-timeout" max={86_400} min={60} type="number" value={draft.timeout_seconds} onChange={(event) => update('timeout_seconds', event.currentTarget.value)} /></div>
                  </div>
                  <p className="schedule-editor__catalog-note" data-state={catalogState}>{catalogNote}</p>
                  {draft.sandbox_mode === 'workspace-write' ? <p className="schedule-editor__warning"><AlertTriangle aria-hidden="true" />Agent 可以修改 Workspace 内的文件。</p> : null}
                  {draft.sandbox_mode === 'danger-full-access' ? <label className="schedule-editor__danger"><input checked={draft.dangerConfirmed} disabled={busy} type="checkbox" onChange={(event) => update('dangerConfirmed', event.currentTarget.checked)} /><span>我理解 Agent 将不受文件系统 sandbox 限制。</span></label> : null}
                </section>
              </form>
            )}
          </DialogBody>

          <DialogFooter className="schedule-editor__footer">
            {schedule ? <Button isDisabled={busy} isPending={phase === 'deleting'} size="sm" variant={deleteArmed ? 'danger' : 'quiet'} onPress={() => void remove()}><Trash2 aria-hidden="true" />{deleteArmed ? '确认删除' : '删除'}</Button> : <span />}
            <div />
            <Button isDisabled={busy} size="sm" variant="quiet" onPress={() => onOpenChange(false)}>取消</Button>
            <Button form="schedule-editor-form" isDisabled={busy} isPending={phase === 'saving'} size="sm" type="submit" variant="primary">保存计划</Button>
          </DialogFooter>
        </DialogContent>
      </Modal>
    </ModalOverlay>
  )
}
