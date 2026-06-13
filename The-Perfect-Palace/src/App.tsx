import { GameProvider, useGame } from './game/store'
import { Setup } from './components/Setup'
import { InitialRoll } from './components/InitialRoll'
import { InitialMapping } from './components/InitialMapping'
import { Game } from './components/Game'
import { EndGame } from './components/EndGame'
import './App.css'

function Router() {
  const { state } = useGame()
  switch (state.phase) {
    case 'setup':
      return <Setup />
    case 'initial-roll':
      return <InitialRoll />
    case 'initial-mapping':
    case 'mapping-reveal':
      return <InitialMapping />
    case 'game-over':
      return <EndGame />
    default:
      return <Game />
  }
}

function App() {
  return (
    <GameProvider>
      <div className="app">
        <header className="app-header">
          <h1>👑 The Perfect Palace</h1>
        </header>
        <Router />
      </div>
    </GameProvider>
  )
}

export default App
