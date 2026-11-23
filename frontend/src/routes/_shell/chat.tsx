import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_shell/chat")({
  component: ChatRoute,
})

function ChatRoute() {
  return null
}
