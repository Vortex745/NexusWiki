import { IMPORT_PARSER_OPTIONS } from "../../lib/constants"

/**
 * Advanced import options (ticket 04): a collapsed-by-default region on the
 * file path only. The parser picker only affects PDF files — everything else
 * auto-routes — so it lives inside the collapsed region. Values are read by
 * the dialog when a wave freezes its snapshot; editing them afterwards must
 * not affect already-queued rows.
 */

export function ImportAdvancedOptions({
  parser,
  onParserChange,
  tagsText,
  onTagsChange,
}: {
  parser: string
  onParserChange: (parser: string) => void
  tagsText: string
  onTagsChange: (tagsText: string) => void
}) {
  return (
    <details className="group rounded-[10px] border border-line bg-surface-subtle">
      <summary className="flex h-8 cursor-pointer select-none items-center gap-1.5 px-3 text-xs font-medium text-muted transition-colors hover:text-ink">
        <span className="transition-transform group-open:rotate-90">›</span>
        高级选项
      </summary>
      <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="import-parser" className="text-xs font-medium text-ink">
            PDF 解析器
          </label>
          <select
            id="import-parser"
            value={parser}
            onChange={(event) => onParserChange(event.target.value)}
            className="h-8 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink"
          >
            {IMPORT_PARSER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted/70">仅对本批中的 PDF 生效；扫描件建议 marker 或 mineru</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="import-tags" className="text-xs font-medium text-ink">
            文档标签
          </label>
          <input
            id="import-tags"
            type="text"
            value={tagsText}
            onChange={(event) => onTagsChange(event.target.value)}
            placeholder="逗号分隔，如：合同, 2026"
            className="h-8 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none placeholder:text-faint focus:border-brand"
          />
        </div>
      </div>
    </details>
  )
}
