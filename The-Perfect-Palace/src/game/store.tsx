import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react'
import type { GameState } from './types'
import type { GameAction } from './actions'
import { initialState, reducer } from './reducer'

const AUTO_SAVE_KEY = 'tpp:autosave'

interface GameContextValue {
  state: GameState
  dispatch: React.Dispatch<GameAction>
}

const GameContext = createContext<GameContextValue | null>(null)

function loadAutoSave(): GameState | null {
  try {
    const raw = localStorage.getItem(AUTO_SAVE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as GameState
  } catch {
    return null
  }
}

function saveAuto(state: GameState): void {
  try {
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(state))
  } catch {
    // localStorage may be full or disabled; ignore.
  }
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const saved = loadAutoSave()
    return saved ?? initialState()
  })

  useEffect(() => {
    saveAuto(state)
  }, [state])

  return <GameContext.Provider value={{ state, dispatch }}>{children}</GameContext.Provider>
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>')
  return ctx
}

export function clearAutoSave(): void {
  try {
    localStorage.removeItem(AUTO_SAVE_KEY)
  } catch {
    // ignore
  }
}

// Named save slots
const NAMED_SAVES_KEY = 'tpp:saves'

export interface NamedSave {
  name: string
  savedAt: number
  state: GameState
}

export function listNamedSaves(): NamedSave[] {
  try {
    const raw = localStorage.getItem(NAMED_SAVES_KEY)
    if (!raw) return []
    return JSON.parse(raw) as NamedSave[]
  } catch {
    return []
  }
}

export function writeNamedSave(name: string, state: GameState): void {
  const all = listNamedSaves()
  const filtered = all.filter((s) => s.name !== name)
  filtered.push({ name, savedAt: Date.now(), state })
  try {
    localStorage.setItem(NAMED_SAVES_KEY, JSON.stringify(filtered))
  } catch {
    // ignore
  }
}

export function deleteNamedSave(name: string): void {
  const all = listNamedSaves().filter((s) => s.name !== name)
  try {
    localStorage.setItem(NAMED_SAVES_KEY, JSON.stringify(all))
  } catch {
    // ignore
  }
}
