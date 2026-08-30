import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { TaskStatus } from '@/lib/api/types'
import type { TaskGanttRow } from './task-types'

export const STATUS_LABELS: Record<TaskStatus, string> = {
  planned: '待安排',
  active: '进行中',
  waiting: '等待中',
  blocked: '已阻塞',
  done: '已完成',
  canceled: '已取消',
}

const STATUS_ORDER = Object.keys(STATUS_LABELS) as TaskStatus[]

function StatusIndicator({ row }: { row: TaskGanttRow }) {
  if (row.status_indicator === 'bar') {
    return (
      <span className="gantt-group-progress" aria-label={`${STATUS_LABELS[row.status]} ${row.progress_count ?? ''}`.trim()}>
        <span className="gantt-group-progress__track" aria-hidden="true">
          <span style={{ width: `${row.progress ?? 0}%` }} />
        </span>
        <span>{row.progress_count ?? '—'}</span>
      </span>
    )
  }
  return (
    <span className="gantt-leaf-status" data-indicator={row.status_indicator} data-status={row.status}>
      <span aria-hidden="true" />
      <span>{STATUS_LABELS[row.status]}</span>
    </span>
  )
}

type MenuItem = { id: string; label: string }
type CloseReason = 'escape' | 'select' | 'outside'
type StatusMenuRequest = {
  row: TaskGanttRow
  anchor: HTMLButtonElement
  onStatusChange: (taskId: string, status: TaskStatus) => void
  onArchive: (taskId: string) => void
}
type StatusMenuController = {
  activeTaskId: string | null
  open: (request: StatusMenuRequest) => void
  close: (reason: CloseReason) => void
}

const StatusMenuContext = createContext<StatusMenuController | null>(null)

function StatusMenu({
  anchor,
  items,
  selectedId,
  onSelect,
  onClose,
}: {
  anchor: HTMLElement
  items: MenuItem[]
  selectedId: string
  onSelect: (id: string) => void
  onClose: (reason: CloseReason) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const anchorRect = anchor.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const margin = 8
    let top = anchorRect.bottom + 4
    if (top + menuRect.height > window.innerHeight - margin) {
      const flipped = anchorRect.top - 4 - menuRect.height
      top = flipped >= margin ? flipped : Math.max(margin, window.innerHeight - margin - menuRect.height)
    }
    const left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - margin - menuRect.width))
    setPosition({ top, left })
  }, [anchor])

  useEffect(() => {
    const focusSelected = () => {
      const menu = menuRef.current
      if (!menu) return
      const selected = menu.querySelector<HTMLElement>('[aria-selected="true"]')
      ;(selected ?? menu.querySelector<HTMLElement>('[role="option"]'))?.focus({ preventScroll: true })
    }
    // SVAR's grid re-focuses its cell after the click that opened the menu.
    // Re-assert focus on the next two frames, so the option keeps focus
    // regardless of when the grid's post-click focus lands.
    focusSelected()
    let inner = 0
    const outer = window.requestAnimationFrame(() => {
      focusSelected()
      inner = window.requestAnimationFrame(focusSelected)
    })
    return () => {
      window.cancelAnimationFrame(outer)
      if (inner) window.cancelAnimationFrame(inner)
    }
  }, [])

  useEffect(() => {
    // Safety net: if focus is still outside the menu (stolen by the grid),
    // reclaim it once so arrow keys reach the listbox, not the grid.
    const handleFocusIn = (event: FocusEvent) => {
      const menu = menuRef.current
      const target = event.target as Node
      // The anchor regaining focus means we are closing — let it keep focus.
      if (!menu || menu.contains(target) || anchor.contains(target)) return
      const selected = menu.querySelector<HTMLElement>('[aria-selected="true"]')
      ;(selected ?? menu.querySelector<HTMLElement>('[role="option"]'))?.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', handleFocusIn)
    return () => document.removeEventListener('focusin', handleFocusIn)
  }, [anchor])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || anchor.contains(target)) return
      onClose('outside')
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [anchor, onClose])

  useEffect(() => {
    const closeForViewportChange = () => onClose('outside')
    document.addEventListener('scroll', closeForViewportChange, true)
    window.addEventListener('resize', closeForViewportChange)
    return () => {
      document.removeEventListener('scroll', closeForViewportChange, true)
      window.removeEventListener('resize', closeForViewportChange)
    }
  }, [onClose])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    const currentIndex = options.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = options[(currentIndex + delta + options.length) % options.length]
      next?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const active = document.activeElement as HTMLElement | null
      if (active?.dataset.optionId) {
        onSelect(active.dataset.optionId)
        onClose('select')
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose('escape')
    } else if (event.key === 'Tab') {
      onClose('outside')
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      className="gantt-native-status__menu"
      aria-label="任务状态"
      style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden', zIndex: 1000 }}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="option"
          tabIndex={-1}
          data-option-id={item.id}
          aria-selected={item.id === selectedId}
          onClick={() => {
            onSelect(item.id)
            onClose('select')
          }}
        >
          {item.label}
        </div>
      ))}
    </div>,
    document.body,
  )
}

export function TaskStatusMenuProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<StatusMenuRequest | null>(null)
  const activeRef = useRef(active)
  const focusFrameRef = useRef(0)
  activeRef.current = active

  useEffect(() => () => {
    if (focusFrameRef.current) window.cancelAnimationFrame(focusFrameRef.current)
  }, [])

  const open = useCallback((request: StatusMenuRequest) => setActive(request), [])
  const close = useCallback((reason: CloseReason) => {
    const current = activeRef.current
    setActive(null)
    if (current && reason !== 'outside') {
      focusFrameRef.current = window.requestAnimationFrame(() => {
        current.anchor.focus({ preventScroll: true })
      })
    }
  }, [])
  const controller = useMemo<StatusMenuController>(() => ({
    activeTaskId: active?.row.id ?? null,
    open,
    close,
  }), [active?.row.id, close, open])

  const canArchive = !!active && !active.row.source.archived_at && ['done', 'canceled'].includes(active.row.status)
  const items: MenuItem[] = STATUS_ORDER.map((status) => ({ id: status, label: STATUS_LABELS[status] }))
  if (canArchive) items.push({ id: 'archive', label: '归档任务' })

  return (
    <StatusMenuContext.Provider value={controller}>
      {children}
      {active && active.anchor.isConnected ? (
        <StatusMenu
          anchor={active.anchor}
          items={items}
          selectedId={active.row.status}
          onSelect={(id) => {
            if (id === 'archive') active.onArchive(active.row.id)
            else active.onStatusChange(active.row.id, id as TaskStatus)
          }}
          onClose={close}
        />
      ) : null}
    </StatusMenuContext.Provider>
  )
}

export function TaskStatusControl({
  row,
  disabled = false,
  onStatusChange = () => undefined,
  onArchive = () => undefined,
}: {
  row: TaskGanttRow
  disabled?: boolean
  onStatusChange?: (taskId: string, status: TaskStatus) => void
  onArchive?: (taskId: string) => void
}) {
  const menu = useContext(StatusMenuContext)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (row.type === 'summary' || row.entity_type === 'project') return <StatusIndicator row={row} />
  if (!menu) throw new Error('TaskStatusControl requires TaskStatusMenuProvider')
  const open = menu.activeTaskId === row.id

  const openMenu = () => {
    if (disabled || !triggerRef.current) return
    menu.open({ row, anchor: triggerRef.current, onStatusChange, onArchive })
  }

  return (
    <span
      className="gantt-native-status"
      data-indicator={row.status_indicator}
      data-status={row.status}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <span aria-hidden="true" />
      <button
        ref={triggerRef}
        type="button"
        className="gantt-native-status__trigger"
        disabled={disabled}
        aria-label={`修改“${row.text}”状态，当前${STATUS_LABELS[row.status]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? menu.close('escape') : openMenu())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            openMenu()
          }
        }}
      >
        {STATUS_LABELS[row.status]}
      </button>
    </span>
  )
}
