import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function ContextCell({
  label,
  value,
  writeText = (text) => navigator.clipboard.writeText(text),
}: {
  label: string
  value: string | null
  writeText?: (value: string) => Promise<void>
}) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [hoverOpen, setHoverOpen] = useState(false)

  useEffect(() => {
    if (feedback === 'idle') return undefined
    const timeout = window.setTimeout(() => {
      setFeedback('idle')
      setHoverOpen(false)
    }, 1_600)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  if (!value) return <span className="gantt-context-cell is-empty">—</span>

  const feedbackText = feedback === 'copied'
    ? `已复制 ${label}`
    : feedback === 'failed'
      ? '复制失败'
      : `${label}：${value}`

  return (
    <TooltipProvider>
      <Tooltip open={feedback !== 'idle' || hoverOpen} onOpenChange={setHoverOpen}>
        <TooltipTrigger asChild>
          <Button
            aria-label={`复制 ${label}`}
            className="gantt-context-cell"
            size="xs"
            type="button"
            variant="ghost"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={async (event) => {
              event.stopPropagation()
              try {
                await writeText(value)
                setFeedback('copied')
              } catch {
                setFeedback('failed')
              }
            }}
          >
            <span>{value}</span>
            {feedback === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{feedbackText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
