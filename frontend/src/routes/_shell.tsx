import { createFileRoute, Outlet } from "@tanstack/react-router"

import { ChatWorkspace } from "@/App"

export const Route = createFileRoute("/_shell")({
  component: ShellLayout,
})

function ShellLayout() {
  return (
    <>
      <ChatWorkspace />
      <Outlet />
    </>
  )
}
