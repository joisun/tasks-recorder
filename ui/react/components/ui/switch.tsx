"use client";

import type * as React from "react";
import * as SwitchPrimitive from "react-aria-components/Switch";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
import { tv } from "tailwind-variants";

const switchStyles = tv({
  slots: {
    root: [
      "group/switch inline-flex cursor-interactive items-center gap-2 text-sm text-fg",
      "disabled:cursor-default disabled:text-fg-disabled",
      "focus-reset focus-visible:focus-ring rounded-md",
    ],
    track: [
      "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-field bg-neutral transition-colors",
      "group-selected/switch:border-primary group-selected/switch:bg-primary",
      "group-disabled/switch:border-border-disabled group-disabled/switch:bg-disabled",
    ],
    thumb: [
      "block size-3.5 translate-x-0.5 rounded-full bg-fg-muted shadow-sm transition-transform",
      "group-selected/switch:translate-x-[1.125rem] group-selected/switch:bg-fg-on-primary",
    ],
  },
});

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Switch>;

function Switch({ className, children, ...props }: SwitchProps) {
  const styles = switchStyles();
  return (
    <SwitchPrimitive.Switch
      data-switch=""
      className={composeRenderProps(className, (value) => styles.root({ className: value }))}
      {...props}
    >
      {composeRenderProps(children, (content) => (
        <>
          <span aria-hidden="true" className={styles.track()} data-slot="switch-track">
            <span className={styles.thumb()} data-slot="switch-thumb" />
          </span>
          {content}
        </>
      ))}
    </SwitchPrimitive.Switch>
  );
}

export { Switch, switchStyles };
export type { SwitchProps };
