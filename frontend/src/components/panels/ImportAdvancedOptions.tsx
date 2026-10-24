import { ExpandableCard } from "../arc/expandable-card/expandable-card"
import { Field as FormField, FieldLabel } from "@/components/primitives/field"
import { Select as UiSelect } from "@/components/ui/Controls"
import { Input } from "@/components/primitives/input"
import { IMPORT_PARSER_OPTIONS } from "../../lib/constants"

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
    <ExpandableCard title="高级选项" description="PDF 解析与文档标签">
      <div className="flex flex-col gap-3">
        <FormField className="flex flex-col gap-1.5">
          <FieldLabel
            htmlFor="import-parser"
            className="text-xs font-medium text-ink"
          >
            PDF 解析器
          </FieldLabel>
          <UiSelect
            id="import-parser"
            value={parser}
            onChange={(event) => onParserChange(event.target.value)}
            className="h-8 w-full border px-2"
          >
            {IMPORT_PARSER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </UiSelect>
          <p className="text-[11px] text-muted-foreground/70">
            默认提取 PDF 文字层；扫描件请选择 OCR API
          </p>
        </FormField>
        <FormField className="flex flex-col gap-1.5">
          <FieldLabel
            htmlFor="import-tags"
            className="text-xs font-medium text-ink"
          >
            文档标签
          </FieldLabel>
          <Input
            id="import-tags"
            type="text"
            value={tagsText}
            onChange={(event) => onTagsChange(event.target.value)}
            placeholder="逗号分隔，如：合同, 2026"
            className="h-8 w-full border px-2"
          />
        </FormField>
      </div>
    </ExpandableCard>
  )
}
