// Money is integer cents everywhere. A PayPal amount string is made only at the edge.

/** cents(510) is "5.10". */
export function cents(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error('cents must be a whole number of cents, got ' + n)
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`
}

/** toCents("5.10") is 510. */
export function toCents(s: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new Error('not an amount: ' + s)
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'))
}

export function sumCents(list: number[]): number {
  return list.reduce((a, b) => {
    if (!Number.isInteger(b)) throw new Error('not whole cents: ' + b)
    return a + b
  }, 0)
}

/** "$5.10" for words on screen and in tool answers. */
export const dollars = (n: number) => '$' + cents(n)
