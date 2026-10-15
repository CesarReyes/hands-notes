import { useCallback, useEffect, useState } from 'react'
import { Library } from './ui/Library'
import { NotebookView } from './ui/NotebookView'

/** Hash routing keeps deep links working on static hosting (GitHub Pages). */
function parseRoute(): { notebookId: string | null } {
  const m = location.hash.match(/^#\/n\/([0-9a-f-]{36})/)
  return { notebookId: m ? m[1] : null }
}

export function App() {
  const [route, setRoute] = useState(parseRoute)

  useEffect(() => {
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const open = useCallback((id: string) => {
    location.hash = `#/n/${id}`
  }, [])
  const back = useCallback(() => {
    location.hash = '#/'
  }, [])

  return route.notebookId ? <NotebookView key={route.notebookId} notebookId={route.notebookId} onBack={back} /> : <Library onOpen={open} />
}
