import { CircleAlert, LoaderCircle, Radio } from 'lucide-react'

import {
  Tooltip,
  TooltipContent,
} from '@/components/ui/tooltip'
import type { DashboardConnectionState } from '@/lib/events/dashboard-event-source'

const PRESENTATION = {
  open: {
    label: '实时连接正常',
    shortLabel: '实时',
    detail: 'Dashboard 会在 taskd 数据变化后自动刷新。',
    icon: Radio,
  },
  connecting: {
    label: '正在恢复实时连接',
    shortLabel: '重连中',
    detail: '继续显示上一次数据，连接恢复后会自动同步。',
    icon: LoaderCircle,
  },
  closed: {
    label: '实时连接已断开',
    shortLabel: '离线',
    detail: '当前页面不会自动刷新；请确认 taskd 和浏览器连接状态。',
    icon: CircleAlert,
  },
} satisfies Record<DashboardConnectionState, {
  label: string
  shortLabel: string
  detail: string
  icon: typeof Radio
}>

export function ConnectionStatus({ state }: { state: DashboardConnectionState }) {
  const presentation = PRESENTATION[state]
  const Icon = presentation.icon
  return (
    <Tooltip>
      <span
            className="connection-status"
            data-state={state}
            role="status"
            aria-label={presentation.label}
          >
            <Icon aria-hidden="true" />
            <span>{presentation.shortLabel}</span>
      </span>
      <TooltipContent placement="bottom end">
        {presentation.detail}
      </TooltipContent>
    </Tooltip>
  )
}
