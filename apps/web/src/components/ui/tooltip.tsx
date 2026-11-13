import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 180,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const portalContainer =
    typeof document !== "undefined" &&
    document.fullscreenElement instanceof HTMLElement
      ? document.fullscreenElement
      : undefined

  return (
    <TooltipPrimitive.Portal container={portalContainer}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-64 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export interface HintTooltipProps {
  label: string
  detail?: string
  shortcut?: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  children: React.ReactElement
}

function HintTooltip({
  label,
  detail,
  shortcut,
  side = "top",
  align = "center",
  children,
}: HintTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-popover-foreground">{label}</span>
          {shortcut && (
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground border border-border">
              {shortcut}
            </kbd>
          )}
        </div>
        {detail && (
          <p className="mt-0.5 text-[10px] text-muted-foreground leading-relaxed">
            {detail}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  HintTooltip,
}
