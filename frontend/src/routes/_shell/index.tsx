import { createFileRoute, Navigate } from "@tanstack/react-router"

import { useSignedInSession } from "@/runtime/SessionContext"

export const Route = createFileRoute("/_shell/")({
  component: IndexRedirect,
})

function IndexRedirect() {
  const session = useSignedInSession()
  return <Navigate to={session?.operator ? "/admin" : "/chat"} replace />
}
