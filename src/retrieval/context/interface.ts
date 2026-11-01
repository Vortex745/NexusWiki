import type { RetrievalResult } from "../../types"
import type { ContextMaterial, ContextMaterialOptions } from "./assembler"

export interface ContextAssembler {
  assemble(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>
  ): Promise<string>
  /**
   * PT-06:AC09 — the shared material entry point. OPTIONAL on purpose: every
   * existing implementer (the complex loop adapter, the runner test fakes, any
   * string-only assembler) keeps compiling and keeps getting `assemble()`.
   * Callers must fall back to `assemble()` when it is absent, and then the
   * preview-based legacy accounting applies — which is exactly what a migrated
   * caller opts out of by wiring `ContextAssemblerImpl`.
   */
  assembleMaterial?(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>,
    options?: ContextMaterialOptions
  ): Promise<ContextMaterial>
}
