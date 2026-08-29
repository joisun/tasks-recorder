import { CircleCheck, CircleX, Send, Square } from 'lucide-react'
import type { KeyboardEvent } from 'react'

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import { Button } from '@/components/ui/button'
import { TextArea } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { RunRecord, RunStatus } from '@/lib/api/types'
import { type LiveEntry, useLiveRun } from './live-run'

const CONNECTION_LABELS = {
  idle: '等待连接',
  connecting: '连接中',
  connected: '实时',
  disconnected: '正在重连',
  unavailable: '浏览器不支持实时连接',
  closed: '已结束',
} as const

function activityIcon(state: string) {
  if (state === 'running') return <Loader aria-label="运行中" />
  if (['failed', 'error', 'canceled'].includes(state)) return <CircleX aria-hidden="true" />
  return <CircleCheck aria-hidden="true" />
}

export function SessionConversation({
  entries,
  emptyText,
  isAnimating = false,
}: {
  entries: LiveEntry[]
  emptyText: string
  isAnimating?: boolean
}) {
  return (
    <Conversation className="live-session__conversation">
      <ConversationContent className="live-session__content">
        {entries.length ? entries.map((entry) => entry.kind === 'message' ? (
          <Message from={entry.role} key={`message-${entry.itemId}`}>
            <MessageContent>
              <MessageResponse className="live-session__message" isAnimating={isAnimating}>
                {entry.text}
              </MessageResponse>
            </MessageContent>
          </Message>
        ) : (
          <div className="live-session__activity" data-state={entry.state} key={`activity-${entry.itemId}`}>
            {activityIcon(entry.state)}
            <span>{entry.label}</span>
          </div>
        )) : (
          <div className="live-session__empty">{emptyText}</div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

export function LiveSession({
  api,
  run,
  onTerminal,
}: {
  api: DashboardApi
  run: RunRecord
  onTerminal: (status: RunStatus) => void
}) {
  const live = useLiveRun({ api, run, onTerminal })

  if (!live.active) return null

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    if (live.canSteer) void live.steer()
  }

  return (
    <section className="live-session" aria-label="Live Session">
      <header className="live-session__header">
        <h3>Live Session</h3>
        <span data-connection={live.connection}>
          <i aria-hidden="true" />{CONNECTION_LABELS[live.connection]}
        </span>
      </header>

      <SessionConversation
        entries={live.entries}
        emptyText="等待 Agent 消息…"
        isAnimating={live.connection === 'connected'}
      />

      {live.resetNotice ? <p className="live-session__notice">{live.resetNotice}</p> : null}
      <div className="live-session__composer">
        <TextArea
          aria-label="追加指令"
          placeholder="补充约束或修正当前方向…"
          value={live.draft}
          onChange={(event) => live.setDraft(event.currentTarget.value)}
          onKeyDown={onComposerKeyDown}
        />
        {live.controlError ? <p className="live-session__error" role="alert">{live.controlError}</p> : null}
        <div className="live-session__composer-actions">
          <span>⌘/Ctrl + Enter</span>
          <Button
            isDisabled={!live.canStop}
            isPending={live.stopping}
            size="sm"
            variant="quiet"
            onPress={() => void live.stop()}
          >
            <Square aria-hidden="true" />停止
          </Button>
          <Button
            isDisabled={!live.canSteer}
            isPending={live.submitting}
            size="sm"
            variant="primary"
            onPress={() => void live.steer()}
          >
            <Send aria-hidden="true" />发送
          </Button>
        </div>
      </div>
    </section>
  )
}
