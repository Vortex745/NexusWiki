import { createFileRoute, Navigate } from "@tanstack/react-router"

import { AdminConsole } from "@/components/admin/AdminConsole"
import { adminSearchSchema } from "@/lib/adminSearch"
import { useSignedInSession } from "@/runtime/SessionContext"

export const Route = createFileRoute("/_shell/admin")({
  validateSearch: adminSearchSchema,
  component: AdminRoute,
})

function AdminRoute() {
  const session = useSignedInSession()
  if (!session?.operator) return <Navigate to="/chat" replace />
  return <AdminConsole />
}
