import { useEffect, useRef } from 'react'
import { useGame } from '../game/store'

export function GameLog() {
  const { state } = useGame()
  const listRef = useRef<HTMLDivElement>(null)

  // Direct scrollTop on the log's own container — never bubbles to the window.
  // scrollIntoView was scrolling the page back to the top on every shop/build/trade click.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.log.length])

  return (
    <aside className="game-log panel">
      <h3>Log</h3>
      <div className="log-entries" ref={listRef}>
        {state.log.slice(-50).map((line, i) => (
          <div key={state.log.length - 50 + i} className="log-entry">
            {line}
          </div>
        ))}
      </div>
    </aside>
  )
}
