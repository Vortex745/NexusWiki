import { createContext, useContext } from "react"
export interface EvidenceTarget {
  messageId: string
  referenceId?: string
}
export const EvidenceContext = createContext<(target: EvidenceTarget) => void>(
  () => {},
)
export const useEvidence = () => useContext(EvidenceContext)
