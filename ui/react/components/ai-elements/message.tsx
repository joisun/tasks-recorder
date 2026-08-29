import { cjk } from '@streamdown/cjk'
import type { ComponentProps, HTMLAttributes } from 'react'
import { memo } from 'react'
import { Streamdown } from 'streamdown'

import { cn } from '@/lib/cn'

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: MessageRole }

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        'group flex w-full max-w-[95%] flex-col gap-2',
        from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
        className,
      )}
      data-role={from}
      {...props}
    />
  )
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export function MessageContent({ children, className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        'flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm',
        'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-fg',
        'group-[.is-assistant]:text-fg',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>

const streamdownPlugins = { cjk }

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (previous, next) => (
    previous.children === next.children
    && previous.isAnimating === next.isAnimating
  ),
)

MessageResponse.displayName = 'MessageResponse'
