export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** Line diff via longest-common-subsequence. Inputs are small config files, so O(n·m) is fine. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ op: ' ', text: x[i]! }), i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: '-', text: x[i++]! });
    else out.push({ op: '+', text: y[j++]! });
  }
  while (i < n) out.push({ op: '-', text: x[i++]! });
  while (j < m) out.push({ op: '+', text: y[j++]! });
  return out;
}

/** Collapse unchanged runs, keeping `context` lines around each change. */
export function compactDiff(lines: DiffLine[], context = 2): Array<DiffLine | { op: '…'; text: string }> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.op !== ' ') for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | { op: '…'; text: string }> = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) (out.push({ op: '…', text: `${skipped} unchanged lines` }), (skipped = 0));
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ op: '…', text: `${skipped} unchanged lines` });
  return out;
}
