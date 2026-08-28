import * as React from 'react'

import { Button } from '@/components/ui/button'

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, 'aria-label' | 'size'> & {
  'aria-label': string
}

function IconButton(props: IconButtonProps) {
  return <Button size="icon" {...props} />
}

export { IconButton, type IconButtonProps }
