import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** Run a command to completion. Never throws on a non-zero exit — the caller decides. */
export function run(cmd, args, { cwd, env, capture = true, label } = {}) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        shell: false,
      });
    } catch (error) {
      // spawn can throw synchronously — EPERM under a sandbox, ENOENT for a missing binary. The caller decides
      // whether that is fatal; a metric needing an external tool should degrade.
      resolve({ code: -1, ms: 0, stdout: '', stderr: error.message, error });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (error) => {
      resolve({ code: -1, ms: 0, stdout, stderr: `${stderr}\n${error.message}`, error });
    });
    child.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (code !== 0 && label) console.error(`  ✗ ${label} exited ${code}\n${tail(stderr || stdout, 20)}`);
      resolve({ code, ms, stdout, stderr });
    });
  });
}

export function tail(text, lines) {
  return String(text).trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * A failure printed as one block: `✗` against the headline, the detail indented under it — which for a
 * {@link startServer} message is the server's own output, where the reason a stage cannot run always is.
 */
export function indent(message) {
  const [headline, ...rest] = String(message).split('\n');
  return [`  ✗ ${headline}`, ...rest.map((line) => `      ${line}`)].join('\n');
}

/**
 * Boot a server and wait until it answers. Returns a handle whose `stop()` takes the whole process
 * group down — Next and Vite both spawn children, and an orphaned child holds the port.
 */
export async function startServer(target, { env, readyPath = '/api/health', timeoutMs = 120_000 } = {}) {
  const [cmd, args] = target.start;
  // Without this an orphan from an earlier run is silently measured instead of the build under test,
  // or — as EADDRINUSE — surfaces as an unexplained "exited 1".
  if (!(await portFree(target.port))) {
    throw new Error(`port ${target.port} is already answering — an orphaned ${target.id} server is still running (lsof -ti :${target.port})`);
  }
  const startedAt = process.hrtime.bigint();
  const child = spawn(cmd, args, {
    cwd: target.dir,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(target.port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  child.stdout.on('data', (d) => {
    log += d;
  });
  child.stderr.on('data', (d) => {
    log += d;
  });

  let exited = null;
  child.on('close', (code) => {
    exited = code;
  });

  const base = `http://127.0.0.1:${target.port}`;
  const deadline = Date.now() + timeoutMs;
  let readyMs = null;
  while (Date.now() < deadline) {
    if (exited !== null) {
      // 'close' can beat the last stdout 'data' events; without a tick the error message is blank.
      await sleep(50);
      throw new Error(`${target.id} server exited ${exited} before answering:\n${tail(log, 30)}`);
    }
    try {
      const res = await fetch(base + readyPath, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        await res.arrayBuffer();
        readyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  if (readyMs === null) {
    await stopTree(child);
    throw new Error(`${target.id} server did not answer ${readyPath} within ${timeoutMs}ms:\n${tail(log, 30)}`);
  }

  return {
    base,
    readyMs,
    pid: child.pid,
    get log() {
      return log;
    },
    stop: () => stopTree(child),
  };
}

export async function stopTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const timer = sleep(5000).then(() => 'timeout');
  if ((await Promise.race([closed, timer])) === 'timeout') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await Promise.race([closed, sleep(2000)]);
  }
}

/** True when a port is free. Used to fail fast rather than measure a stale server. */
export async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}
