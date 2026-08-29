import { ArrowDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, ...props }: ConversationProps) {
  return (
    <StickToBottom
      className={cn('relative flex-1 overflow-y-hidden', className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  )
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return (
    <StickToBottom.Content
      className={cn('flex flex-col gap-6 p-4', className)}
      {...props}
    />
  )
}

export type ConversationScrollButtonProps = Omit<ComponentProps<typeof Button>, 'onPress'>

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  const handlePress = useCallback(() => scrollToBottom(), [scrollToBottom])

  if (isAtBottom) return null

  return (
    <Button
      aria-label="滚动到最新消息"
      className={cn('absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full', className)}
      isIconOnly
      size="sm"
      variant="secondary"
      onPress={handlePress}
      {...props}
    >
      <ArrowDown aria-hidden="true" />
    </Button>
  )
}
