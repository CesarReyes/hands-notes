import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { initAuth } from './store/auth'
import './styles.css'

// Theme follows the system; the editor reads data-theme for its desk color.
const media = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => (document.documentElement.dataset.theme = media.matches ? 'dark' : 'light')
applyTheme()
media.addEventListener('change', applyTheme)

// Ask the browser not to evict our IndexedDB under storage pressure.
void navigator.storage?.persist?.()

registerSW({ immediate: true })
initAuth()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
