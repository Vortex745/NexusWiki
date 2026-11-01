// One seam between the app and lucide-react: every glyph the app's own UI
// draws is picked here, under lucide's canonical names and grouped by
// purpose, so the mapping is reviewable in one screen. The arc/* library
// components keep their own direct lucide-react imports. Named imports keep
// every unchosen glyph out of the bundle.
//
// Lucide glyphs carry their paint (stroke="currentColor", round caps) on
// their own root svg, so nothing here needs a global paint default — see
// styles/index.css.

// -- Navigation & layout ----------------------------------------------------
export { ArrowDown } from "lucide-react"
export { ChevronDown } from "lucide-react"
export { ChevronLeft } from "lucide-react"
export { ChevronRight } from "lucide-react"
export { PanelLeft } from "lucide-react"
export { PanelLeftClose } from "lucide-react"

// -- Status & feedback ------------------------------------------------------
export { Ban } from "lucide-react"
export { Check } from "lucide-react"
export { Circle } from "lucide-react"
export { CircleAlert } from "lucide-react"
export { CircleCheck } from "lucide-react"
export { CircleQuestionMark } from "lucide-react"
export { CircleX } from "lucide-react"
export { Clock } from "lucide-react"
export { History } from "lucide-react"
export { LoaderCircle } from "lucide-react"
export { Minus } from "lucide-react"
export { Plus } from "lucide-react"
export { ShieldAlert } from "lucide-react"
export { X } from "lucide-react"

// -- Actions ----------------------------------------------------------------
export { ClipboardCheck } from "lucide-react"
export { Copy } from "lucide-react"
export { Eye } from "lucide-react"
export { Pencil } from "lucide-react"
export { RefreshCw } from "lucide-react"
export { ScrollText } from "lucide-react"
export { Search } from "lucide-react"
export { ArrowUp } from "lucide-react"
export { ArrowUpDown } from "lucide-react"
export { SendHorizontal } from "lucide-react"
export { Square } from "lucide-react"
export { Trash2 } from "lucide-react"
export { Upload } from "lucide-react"

// -- Theme & app chrome -----------------------------------------------------
export { Moon } from "lucide-react"
export { Settings } from "lucide-react"
export { Sparkles } from "lucide-react"
export { Sun } from "lucide-react"

// -- Domain glyphs ----------------------------------------------------------
export { Archive } from "lucide-react"
export { ArchiveRestore } from "lucide-react"
export { BookOpen } from "lucide-react"
export { Bot } from "lucide-react"
export { ChartColumn } from "lucide-react"
export { Database } from "lucide-react"
export { FileText } from "lucide-react"
export { FlaskConical } from "lucide-react"
export { Folder } from "lucide-react"
export { FolderOpen } from "lucide-react"
export { LayoutGrid } from "lucide-react"
export { Lightbulb } from "lucide-react"
export { Network } from "lucide-react"
export { NotebookPen } from "lucide-react"
export { PlugZap } from "lucide-react"
export { Shield } from "lucide-react"
export { Users } from "lucide-react"
