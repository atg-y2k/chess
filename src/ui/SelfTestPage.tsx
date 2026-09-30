/**
 * Engine diagnostics page (`?enginetest`): runs `runEngineSelfTest` (both Stockfish workers: init,
 * searches, MultiPV, mate, bot strength options, cache, concurrency) and shows the live log with a
 * PASS / FAIL verdict and a "Copy log" button, so the engine can be checked on a real iPhone.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { copyText } from '../clipboard';
import { runEngineSelfTest } from '../engine/selfTest';
import './SelfTestPage.css';

type Status = 'running' | 'pass' | 'fail';

export interface SelfTestPageProps {
  /** Runs the test (default: `runEngineSelfTest`); injectable for tests. */
  run?: (log: (line: string) => void) => Promise<boolean>;
  /** Copies text; resolves whether it worked. */
  copy?: (text: string) => Promise<boolean>;
}

/** Full-page self-test report. Re-runnable; the log is selectable and copyable. */
export function SelfTestPage({ run = runEngineSelfTest, copy = copyText }: SelfTestPageProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('running');
  const [runId, setRunId] = useState(0);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    setLines([]);
    setStatus('running');
    const log = (line: string) => {
      if (alive) setLines((l) => [...l, line]);
    };
    run(log)
      .catch((e: unknown) => {
        log(`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      })
      .then((ok) => {
        if (alive) setStatus(ok ? 'pass' : 'fail');
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  // Follow the log while it grows.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const text = lines.join('\n');
  const appUrl = `${import.meta.env.BASE_URL}`;

  return (
    <div class="selftest" data-status={status}>
      <header class="selftest-head">
        <h1 class="selftest-title">Engine self-test</h1>
        <div class="selftest-verdict" role="status" aria-live="polite" data-id="verdict">
          {status === 'running' ? (
            <>
              <span class="selftest-spin" aria-hidden="true" />
              Running…
            </>
          ) : status === 'pass' ? (
            'PASS'
          ) : (
            'FAIL'
          )}
        </div>
      </header>
      <p class="selftest-intro">
        Starts the two Stockfish workers the app uses and checks searches, MultiPV, a mate in 2, the bot’s
        strength settings, the analysis cache and both engines running at once. It takes about 15 seconds.
      </p>
      <pre class="selftest-log" ref={logRef} aria-label="Self-test log" tabIndex={0}>
        {text || 'Starting…'}
      </pre>
      <div class="selftest-actions">
        <button
          type="button"
          class="btn btn-primary"
          data-id="copy-log"
          disabled={!text}
          onClick={() => void copy(text).then((ok) => setCopied(ok ? 'ok' : 'fail'))}
        >
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : 'Copy log'}
        </button>
        <button type="button" class="btn" data-id="run-again" disabled={status === 'running'} onClick={() => setRunId((n) => n + 1)}>
          Run again
        </button>
        <a class="btn btn-ghost selftest-back" href={appUrl}>
          Open app
        </a>
      </div>
    </div>
  );
}
