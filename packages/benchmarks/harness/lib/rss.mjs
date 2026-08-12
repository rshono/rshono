import { run } from './proc.mjs';

/**
 * Resident memory of a process *and its children*: `next start` and `vite preview` both fork, so reading only
 * the spawned pid would flatter whichever framework pushes the most work into a child.
 *
 * A tree sum is not actionable on its own — it carries the `npm run start` process and double-counts shared
 * pages — so `breakdown` comes back beside it, largest first, separating the server from the scaffolding.
 */
export async function treeRss(rootPid) {
  const { code, stdout, error } = await run('ps', ['-eo', 'pid=,ppid=,rss=,comm=']);
  // Some sandboxes deny spawning `ps`; memory is then not reported rather than failing an otherwise fine run.
  if (code !== 0 || error) return null;

  const children = new Map();
  const rss = new Map();
  const comm = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    rss.set(pid, Number(m[3]) * 1024);
    comm.set(pid, m[4]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  if (!rss.has(rootPid)) return null;

  let total = 0;
  const breakdown = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const bytes = rss.get(pid) ?? 0;
    total += bytes;
    // Basename only: the full argv wraps a terminal and adds nothing over "which binary is this".
    breakdown.push({ pid, bytes, comm: (comm.get(pid) ?? '?').split('/').pop() });
    stack.push(...(children.get(pid) ?? []));
  }
  breakdown.sort((a, b) => b.bytes - a.bytes);
  return { bytes: total, processes: breakdown.length, largest: breakdown[0]?.bytes ?? 0, breakdown };
}
