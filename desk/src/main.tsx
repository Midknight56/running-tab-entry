import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// The licence key, when there is one, comes from the Worker at runtime; it is never in the repo.
fetch('/desk/config').then((r) => r.json()).catch(() => ({})).then((c: { ag_studio_license?: string | null }) => {
  createRoot(document.getElementById('root')!).render(<App license={c.ag_studio_license ?? null} />)
})
