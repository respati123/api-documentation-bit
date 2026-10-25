export type TextDiffRow = {
  leftText: string
  rightText: string
  leftLine: number | null
  rightLine: number | null
  kind: 'same' | 'removed' | 'added'
}

const maxDiffCells = 500_000

export function diffText(before: string, after: string): TextDiffRow[] {
  const left = before ? before.split('\n') : []
  const right = after ? after.split('\n') : []
  if (!left.length && !right.length) return []
  const columns = right.length + 1
  const cells = (left.length + 1) * columns

  if (cells > maxDiffCells) {
    return [
      ...left.map((leftText, index) => ({ leftText, rightText: '', leftLine: index + 1, rightLine: null, kind: 'removed' as const })),
      ...right.map((rightText, index) => ({ leftText: '', rightText, leftLine: null, rightLine: index + 1, kind: 'added' as const }))
    ]
  }

  const lengths = new Uint32Array(cells)
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex--) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex--) {
      const cell = leftIndex * columns + rightIndex
      lengths[cell] = left[leftIndex] === right[rightIndex]
        ? lengths[(leftIndex + 1) * columns + rightIndex + 1] + 1
        : Math.max(lengths[(leftIndex + 1) * columns + rightIndex], lengths[cell + 1])
    }
  }

  const rows: TextDiffRow[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) {
      rows.push({ leftText: left[leftIndex], rightText: right[rightIndex], leftLine: leftIndex + 1, rightLine: rightIndex + 1, kind: 'same' })
      leftIndex++
      rightIndex++
    } else if (leftIndex < left.length && (rightIndex >= right.length || lengths[(leftIndex + 1) * columns + rightIndex] >= lengths[leftIndex * columns + rightIndex + 1])) {
      rows.push({ leftText: left[leftIndex], rightText: '', leftLine: leftIndex + 1, rightLine: null, kind: 'removed' })
      leftIndex++
    } else {
      rows.push({ leftText: '', rightText: right[rightIndex], leftLine: null, rightLine: rightIndex + 1, kind: 'added' })
      rightIndex++
    }
  }
  return rows
}
