import 'tdesign-react/es/_util/react-19-adapter'
import 'tdesign-react/es/style/index.css'
import './lib/td-tokens.css'
import 'streamdown/styles.css'
import './index.css'

import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import ConfigProvider from 'tdesign-react/es/config-provider'
import zhCN from 'tdesign-react/es/locale/zh_CN'
import App from './App.tsx'
import { ThemeProvider } from '@/components/theme-provider.tsx'

function TdBridge({ children }: { children: ReactNode }) {
  return <ConfigProvider globalConfig={zhCN}>{children}</ConfigProvider>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TdBridge>
        <App />
      </TdBridge>
    </ThemeProvider>
  </StrictMode>
)
