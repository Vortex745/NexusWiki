/**
 * Ambient module declaration for `@llamaindex/env/tokenizers`.
 *
 * The package only exposes this subpath through its `exports` map, which
 * tsc's `moduleResolution: "node"` cannot read (TS2307). The declaration
 * re-exports the real types from the direct file path, which node10
 * resolution CAN see. Runtime resolution is unaffected: tsx/Node use the
 * exports map and load `dist/index.cjs`.
 */
declare module "@llamaindex/env/tokenizers" {
  export * from "@llamaindex/env/tokenizers/dist/index.js"
}
