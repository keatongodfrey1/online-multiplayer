import type { ResourceOutcome } from '../game/types'
import { BOARD } from '../game/board'

export function outcomeLabel(o: ResourceOutcome): string {
  switch (o.kind) {
    case 'sticks':
      return `${o.amount} sticks`
    case 'bricks':
      return `${o.amount} bricks`
    case 'dollars':
      return `$${o.amount}`
    case 'draw-card':
      return 'Draw a card'
  }
}

export function squareLabel(n: number): string {
  const s = BOARD.find((sq) => sq.number === n)
  return s ? `#${n} — ${s.label}` : `#${n}`
}
