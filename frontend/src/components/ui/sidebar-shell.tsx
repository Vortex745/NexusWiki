"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X as XIcon } from "./icons"
import { cn } from "../../lib/cn"

import { useIsMobile } from "@/hooks/use-mobile"

const SIDEBAR_WIDTH = "16rem"
const SIDEBAR_WIDTH_MOBILE = "18rem"
const SIDEBAR_WIDTH_ICON = "3rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }
  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }
    },
    [setOpenProp, open],
  )

  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((value) => !value) : setOpen((value) => !value)
  }, [isMobile, setOpen])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])

  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar],
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

/** Mobile slide-in surface, local port of the removed sheet primitive (Radix dialog + the same classes). */
function SidebarSheet({
  open,
  onOpenChange,
  side = "left",
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: "left" | "right"
}) {
  const returnFocus = React.useRef<HTMLElement | null>(null)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-motion-surface="sheet-overlay"
          className="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
        />
        <DialogPrimitive.Content
          data-slot="sidebar-sheet"
          data-motion-surface="sheet"
          data-side={side}
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault()
              returnFocus.current.focus()
            }
          }}
          className={cn(
            "fixed z-50 flex flex-col gap-4 bg-surface-raised bg-clip-padding text-sm text-ink shadow-lg data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l",
            className,
          )}
          style={{ "--sidebar-width": SIDEBAR_WIDTH_MOBILE } as React.CSSProperties}
          {...props}
        >
          <DialogPrimitive.Title className="sr-only">工作区导航</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            对话、知识库和工作区工具
          </DialogPrimitive.Description>
          {children}
          <DialogPrimitive.Close
            className="absolute top-3 right-3"
            aria-label="关闭"
          >
            <XIcon className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function SidebarShell({
  side = "left",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

  if (isMobile) {
    return (
      <SidebarSheet
        open={openMobile}
        onOpenChange={setOpenMobile}
        side={side}
        className={cn("w-(--sidebar-width) bg-surface p-0 text-ink", className)}
      >
        <div className="flex h-full w-full flex-col">{children}</div>
      </SidebarSheet>
    )
  }

  return (
    <div
      className="group peer hidden text-ink md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? "icon" : ""}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
          "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
      />
      <div
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=icon]:w-(--sidebar-width-icon) data-[side=left]:border-r data-[side=right]:right-0 data-[side=right]:border-l md:flex",
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex size-full flex-col bg-surface"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

export { SidebarProvider, SidebarShell, useSidebar }
