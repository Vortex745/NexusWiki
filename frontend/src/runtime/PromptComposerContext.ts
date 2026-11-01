import { createContext, useContext } from "react"

/**
 * Turns the text the user sees into the text sent to the backend.
 *
 * The composer lives inside the assistant-ui runtime, but the extra context
 * (long-term memory + staged attachments) is owned by the app shell. This
 * context keeps the runtime provider from having to know about either.
 */
export type PromptComposer = (displayText: string) => string

const PromptComposerContext = createContext<PromptComposer>((displayText) => displayText)

export const PromptComposerProvider = PromptComposerContext.Provider

export function usePromptComposer(): PromptComposer {
  return useContext(PromptComposerContext)
}
