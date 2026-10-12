/**
 * Damerau–Levenshtein (optimal string alignment) distance with an early-exit bound.
 * Returns a value > max as soon as the distance is known to exceed `max`.
 */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prevPrev = new Array<number>(lb + 1).fill(0);
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  let cur = new Array<number>(lb + 1).fill(0);

  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prevPrev, prev, cur] = [prev, cur, prevPrev];
  }
  return prev[lb];
}
