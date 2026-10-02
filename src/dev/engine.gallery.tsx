/**
 * Dev page for the engine layer: /gallery.html?g=engine (add &engines=1 for the single-worker
 * fallback, &engines=2 to force two workers). Runs runEngineSelfTest() and shows its log.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { runEngineSelfTest } from '../engine/selfTest';

type Status = 'idle' | 'running' | 'pass' | 'fail';

const CSS = `
.eg { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px;
  padding: 16px 16px 12px; max-width: 760px; width: 100%; margin: 0 auto; }
.eg-head { display: flex; align-items: center; gap: 12px; }
.eg-title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.eg-sub { margin: 2px 0 0; color: var(--text-dim); font-size: 13px; }
.eg-pill { margin-left: auto; padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 700;
  letter-spacing: 0.04em; text-transform: uppercase; background: var(--surface-3); color: var(--text-dim);
  white-space: nowrap; }
.eg-pill[data-status='running'] { background: var(--surface-3); color: var(--text); }
.eg-pill[data-status='pass'] { background: var(--accent); color: var(--accent-text); }
.eg-pill[data-status='fail'] { background: var(--danger); color: #fff; }
.eg-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.eg-seg a { display: flex; align-items: center; justify-content: center; min-height: 44px; border-radius: var(--radius-sm);
  color: var(--text-dim); text-decoration: none; font-weight: 600; font-size: 14px; }
.eg-seg a[aria-current='page'] { background: var(--surface-3); color: var(--text); }
.eg-actions { display: flex; gap: 8px; }
.eg-actions .btn-primary { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 10px; }
.eg-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent;
  animation: eg-rot 0.8s linear infinite; }
@keyframes eg-rot { to { transform: rotate(360deg); } }
.eg-log { flex: 1; min-height: 160px; overflow: auto; -webkit-overflow-scrolling: touch; margin: 0;
  padding: 12px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border);
  font: 12px/1.5 var(--font-mono); color: var(--text-dim); white-space: pre-wrap; word-break: break-word;
  user-select: text; -webkit-user-select: text; }
.eg-log > div { padding-left: 4ch; text-indent: -4ch; }
.eg-log .ok { color: var(--text); }
.eg-log .ok b { color: var(--accent); font-weight: 700; }
.eg-log .fail { color: var(--danger); font-weight: 700; }
.eg-log .res { color: var(--text); font-weight: 700; }
.eg-empty { color: var(--text-faint); }
.eg-foot { color: var(--text-faint); font-size: 12px; margin: 0; }
`;

const MODES: { label: string; value: string | null }[] = [
  { label: 'Auto', value: null },
  { label: 'Two workers', value: '2' },
  { label: 'One worker', value: '1' },
];

function modeHref(value: string | null): string {
  const q = new URLSearchParams(location.search);
  if (value === null) q.delete('engines');
  else q.set('engines', value);
  return `?${q.toString()}`;
}

function LogLine({ line }: { line: string }) {
  const m = /^(\[\s*\d+ ms\] )(ok |FAIL|RESULT:)?(.*)$/.exec(line);
  if (!m) return <div>{line}</div>;
  const [, time, tag, rest] = m;
  if (tag === 'FAIL') return <div class="fail">{line}</div>;
  if (tag === 'RESULT:') return <div class={/PASS/.test(rest) ? 'res' : 'fail'}>{line}</div>;
  if (tag === 'ok ') {
    return (
      <div class="ok">
        {time}
        <b>ok</b> {rest}
      </div>
    );
  }
  return <div>{line}</div>;
}

export default function EngineGallery() {
  const [status, setStatus] = useState<Status>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const param = new URLSearchParams(location.search).get('engines');

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = async () => {
    setStatus('running');
    setLines([]);
    try {
      const ok = await runEngineSelfTest((l) => setLines((prev) => [...prev, l]));
      setStatus(ok ? 'pass' : 'fail');
    } catch (e) {
      setLines((prev) => [...prev, `error: ${String(e)}`]);
      setStatus('fail');
    }
  };

  const copy = () => {
    void navigator.clipboard?.writeText(lines.join('\n')).catch(() => undefined);
  };

  const statusText = { idle: 'Not run', running: 'Running', pass: 'Pass', fail: 'Fail' }[status];

  return (
    <div class="eg">
      <style>{CSS}</style>
      <div class="eg-head">
        <div>
          <h1 class="eg-title">Engine self-test</h1>
          <p class="eg-sub">Stockfish 19 lite · WASM worker</p>
        </div>
        <span class="eg-pill" data-status={status} id="engine-status">
          {statusText}
        </span>
      </div>
      <nav class="eg-seg" aria-label="Engine mode">
        {MODES.map((m) => (
          <a key={m.label} href={modeHref(m.value)} aria-current={param === m.value ? 'page' : undefined}>
            {m.label}
          </a>
        ))}
      </nav>
      <div class="eg-actions">
        <button class="btn btn-primary" id="run-selftest" disabled={status === 'running'} onClick={run}>
          {status === 'running' ? <span class="eg-spin" aria-hidden="true" /> : null}
          {status === 'running' ? 'Testing…' : status === 'idle' ? 'Run self-test' : 'Run again'}
        </button>
        <button class="btn" disabled={lines.length === 0 || status === 'running'} onClick={copy}>
          Copy log
        </button>
      </div>
      <pre class="eg-log" ref={logRef} aria-live="polite">
        {lines.length === 0 ? (
          <span class="eg-empty">
            Starts the engines the app would use, runs searches (depth 12, MultiPV 3, mate in 2, bot strength), checks
            the analysis cache, then keeps both engines busy for 8 s. Takes about 12 s.
          </span>
        ) : (
          lines.map((l, i) => <LogLine key={i} line={l} />)
        )}
      </pre>
      <p class="eg-foot">Mode is chosen by createEngines(): “Auto” may fall back to one worker after a crash.</p>
    </div>
  );
}
