/**
 * PostgREST's `order` parameter over the fake's rows: `column[.asc|.desc][.nullsfirst|.nullslast]`,
 * several separated by commas, the first deciding before the next. As in Postgres, a column runs
 * ascending unless it says otherwise, and its nulls come last ascending and first descending. Rows
 * that tie on every column keep the order they were stored in.
 */
export function ordered(rows, order) {
  if (order === null || order === '') return [...rows]
  const keys = order.split(',').map(keyOf)
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const difference = compared(a[key.column], b[key.column], key)
      if (difference !== 0) return difference
    }
    return 0
  })
}

function keyOf(term) {
  const [column, ...modifiers] = term.trim().split('.')
  const descending = modifiers.includes('desc')
  const nullsFirst = modifiers.includes('nullsfirst')
    ? true
    : modifiers.includes('nullslast')
      ? false
      : descending
  return { column, descending, nullsFirst }
}

function compared(a, b, { descending, nullsFirst }) {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) {
    if (aNull && bNull) return 0
    return aNull === nullsFirst ? -1 : 1
  }
  const difference = valueOrder(a, b)
  return descending ? -difference : difference
}

/** Numbers by size, timestamps by time, other text by its characters. */
function valueOrder(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (TIMESTAMP.test(String(a)) && TIMESTAMP.test(String(b))) {
    return Date.parse(String(a)) - Date.parse(String(b))
  }
  const aText = String(a)
  const bText = String(b)
  return aText < bText ? -1 : aText > bText ? 1 : 0
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
