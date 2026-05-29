import { Canvas } from '@piano/shared'

type PositionedNode = {
  id?: string
  position: {
    x: number
    y: number
  }
}

const DEFAULT_ROW_TOLERANCE = Canvas.NODE_DIMENSIONS.HEIGHT * 0.4

export function sortNodesByReadingOrder<T extends PositionedNode>(
  nodes: T[],
  rowTolerance: number = DEFAULT_ROW_TOLERANCE,
): T[] {
  const rows: Array<{ averageY: number; items: T[] }> = []
  const sortedByY = [...nodes].sort(compareByYThenX)

  for (const node of sortedByY) {
    const row = rows[rows.length - 1]

    if (!row || Math.abs(node.position.y - row.averageY) > rowTolerance) {
      rows.push({ averageY: node.position.y, items: [node] })
      continue
    }

    row.items.push(node)
    row.averageY = row.items.reduce((sum, item) => sum + item.position.y, 0) / row.items.length
  }

  return rows.flatMap((row) => [...row.items].sort(compareByXThenY))
}

function compareByYThenX(a: PositionedNode, b: PositionedNode): number {
  return a.position.y - b.position.y || a.position.x - b.position.x || compareIds(a, b)
}

function compareByXThenY(a: PositionedNode, b: PositionedNode): number {
  return a.position.x - b.position.x || a.position.y - b.position.y || compareIds(a, b)
}

function compareIds(a: PositionedNode, b: PositionedNode): number {
  return (a.id ?? '').localeCompare(b.id ?? '')
}
