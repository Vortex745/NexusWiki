import { code } from '@streamdown/code'
import { defaultRemarkPlugins, Streamdown } from 'streamdown'
import remarkBreaks from 'remark-breaks'

// remarkPlugins prop 是整体替换默认插件（非合并），必须带上 defaultRemarkPlugins 保住 gfm/codeMeta。
// 模块级常量维持引用稳定，避免每帧重算插件链与处理器缓存失效。
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkBreaks]

// animated 只启动动画引擎，isAnimating 驱动实际的播放与光标（见 streamdown README 用法）
export function Markdown({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      animated={streaming || undefined}
      isAnimating={streaming || undefined}
      caret="block"
      plugins={{ code }}
      remarkPlugins={REMARK_PLUGINS}
      className="cirrus-md break-words"
    >
      {content}
    </Streamdown>
  )
}
