import { useState } from "react"

import { knowledgeStore } from "../../runtime/knowledgeStore"
import { useAppShell } from "../../runtime/AppShellContext"
import { Dialog } from "../ui/Dialog"
import { Button, TextInput } from "../ui/Controls"

/** Creating a knowledge base lives in its own dialog, not in the manage body. */
export function KnowledgeCreateDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useAppShell()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)

  const close = () => {
    if (busy) return
    setName("")
    setDescription("")
    onClose()
  }

  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await knowledgeStore.create(name.trim(), description.trim() || undefined)
      showToast("知识库已创建")
      setName("")
      setDescription("")
      onClose()
    } catch (error) {
      showToast(error instanceof Error ? error.message : "知识库创建失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="新建知识库"
      titleId="knowledge-create-title"
      tier="confirm"
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={close} disabled={busy}>
            取消
          </Button>
          <Button
            size="sm"
            tone="primary"
            onClick={() => void create()}
            disabled={busy || !name.trim()}
          >
            {busy ? "创建中…" : "创建"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <TextInput
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create()
          }}
          placeholder="知识库名称（必填）"
          maxLength={200}
        />
        <TextInput
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create()
          }}
          placeholder="描述（可选）"
          maxLength={2000}
        />
      </div>
    </Dialog>
  )
}
