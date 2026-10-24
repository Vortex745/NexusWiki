import type { Query, RouterCallOptions, RouterDecision } from "../../types"

export interface Router {
  decide(query: Query, options?: RouterCallOptions): Promise<RouterDecision>
}
