import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { diagSummaryText, iniDiff, parseDiag, parseIni, signatureOf } from '../diag/parse.js';
import type { DiagInput } from '../diag/types.js';

const FIX = new URL('./fixtures/diag/', import.meta.url);
const fixture = (name: string): DiagInput => ({ name, text: fs.readFileSync(new URL(name, FIX), 'utf8') });
const CF_AOI = ['20260712.jsonl', 'incident_20260712_053710_819.json', 'incident_20260712_053711_616.json'];

describe('cf-aoi flight recorder (real _diag samples)', () => {
  const p = parseDiag(CF_AOI.map(fixture));

  it('parses the session line (and merges the identical session embedded in incident files)', () => {
    expect(p.sessions).toHaveLength(1);
    const s = p.sessions[0]!;
    expect(s).toMatchObject({
      ts: '2026-07-12T05:37:05.066',
      ip_name: 'IP01',
      mode: 'offline-tcp',
      ini: 'config/default_zone.ini',
      recipe: '(none)',
      ai_active: false,
    });
    expect(s.gpu).toEqual({ name: 'NVIDIA GeForce RTX 2080 SUPER', sm: 75, free_mb: 7542, total_mb: 7763 });
  });

  it('types every jsonl line, keeps the parsed object, recipes summarised', () => {
    const jsonl = p.events.filter((e) => e.input === '20260712.jsonl');
    expect(jsonl.map((e) => e.type)).toEqual([
      'session', 'recipe', 'incident', 'incident_suppressed', 'recipe', 'incident', 'recipe', 'other',
    ]);
    expect(jsonl.map((e) => e.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const recipe = jsonl[1]!;
    expect(recipe.detail).toContain('FRV2_A (inline xml) panel=frv2');
    expect(recipe.detail).toContain('pitch=26x19');
    expect(recipe.data?.label).toBe('FRV2_A (inline xml) panel=frv2');
    expect(jsonl[7]!.kind).toBe('stats');
    expect(p.warnings).toEqual([]);
  });

  it('incidents: bad_json at control_server.cpp:407, de-duplicated across the jsonl and the incident file', () => {
    expect(p.incidents.map((e) => e.kind)).toEqual(['bad_json', 'defect_flood']);
    const bad = p.incidents[0]!;
    expect(bad.type).toBe('incident');
    expect(bad.src[0]).toEqual({ file: 'ip/src/control_server.cpp', line: 407, func: null });
    expect(bad.detail).toContain('parse_error.101');
    expect(p.incidents[1]!.src[0]).toEqual({ file: 'ip/src/main.cpp', line: 225, func: null });
    // the incident file's richer object (current_frame / recent_frames) replaced the jsonl index line
    expect(p.incidents[1]!.data).toHaveProperty('current_frame');
    // suppressed one counted: 1 full + 1 suppressed; defect_flood once although it is in two inputs
    expect(p.summary.incidents_by_kind).toEqual({ bad_json: 2, defect_flood: 1 });
    expect(p.errors).toEqual(p.incidents);
  });

  it('summary + signature', () => {
    expect(p.summary.inputs).toBe(3);
    expect(p.summary.first_ts).toBe('2026-07-12T05:37:05.066');
    expect(p.summary.last_ts).toBe('2026-07-12T05:39:25.742');
    expect(p.summary.src_files['ip/src/control_server.cpp']).toBeGreaterThan(0);
    expect(p.signature).toContain('incident:bad_json@ip/src/control_server.cpp');
    expect(p.signature).toContain('incident:defect_flood@ip/src/main.cpp');
    expect(p.signature).toContain('src:ip/src/control_server.cpp:407');
    expect(p.signature).toEqual([...p.signature].sort());
    expect(signatureOf(p)).toEqual(p.signature);
  });

  it('an incident file alone still counts and yields its embedded session', () => {
    const one = parseDiag([fixture('incident_20260712_053711_616.json')]);
    expect(one.incidents).toHaveLength(1);
    expect(one.incidents[0]!.kind).toBe('defect_flood');
    expect(one.sessions[0]!.ip_name).toBe('IP01');
    expect(one.sessions[0]!.ts).toBeNull();
    expect(one.summary.incidents_by_kind).toEqual({ defect_flood: 1 });
  });

  it('diagSummaryText names machine, GPU, incidents and stays under the cap', () => {
    const t = diagSummaryText(p);
    expect(t.length).toBeLessThanOrEqual(4000);
    expect(t).toContain('IP01');
    expect(t).toContain('offline-tcp');
    expect(t).toContain('RTX 2080 SUPER');
    expect(t).toContain('bad_json ×2');
    expect(t).toContain('ip/src/control_server.cpp:407');
    expect(t).not.toMatch(/^\|.*\|$/m); // no markdown tables
    for (const cap of [1500, 600, 200, 50]) expect(diagSummaryText(p, cap).length).toBeLessThanOrEqual(cap);
  });
});

describe('incident shapes the samples do not show', () => {
  it('stack (string from the recorder, or an array) becomes src frames after the incident src', () => {
    const inc = {
      type: 'incident',
      ts: '2026-07-12T06:00:00.000',
      kind: 'uncaught_exception',
      detail: 'std::runtime_error: grab failed ERR_GRAB_TIMEOUT',
      src: 'ip/src/grabber.cpp:88',
      stack: '#0 0x00007f in diag::boom (x=1) at ip/src/diag/flight_recorder.cpp:240\n#1 0x00008f in main () at ip/src/main.cpp:300',
      suppressed_since_last: 5,
    };
    const p = parseDiag([{ name: 'incident_x.json', text: JSON.stringify(inc) }]);
    const e = p.incidents[0]!;
    expect(e.src.map((r) => `${r.file}:${r.line}`)).toEqual([
      'ip/src/grabber.cpp:88', 'ip/src/diag/flight_recorder.cpp:240', 'ip/src/main.cpp:300',
    ]);
    expect(e.src[1]!.func).toBe('diag::boom');
    expect(e.codes).toContain('ERR_GRAB_TIMEOUT');
    expect(p.summary.incidents_by_kind).toEqual({ uncaught_exception: 6 });

    const arr = parseDiag([{ name: 'i.json', text: JSON.stringify({ ...inc, stack: ['ip/src/a.cpp:1', 'ip/src/b.cu:2'] }) }]);
    expect(arr.incidents[0]!.src.map((r) => r.file)).toEqual(['ip/src/grabber.cpp', 'ip/src/a.cpp', 'ip/src/b.cu']);
  });

  it('suppressed runs count their max (counter written at 1, 101, …), not the sum', () => {
    const lines = [
      { type: 'incident', ts: '10:00:00', kind: 'rdma_nocrc', detail: 'd', src: 'ip/src/rdma.cpp:9' },
      { type: 'incident_suppressed', ts: '10:00:01', kind: 'rdma_nocrc', detail: 'd', src: 'ip/src/rdma.cpp:9', suppressed: 1 },
      { type: 'incident_suppressed', ts: '10:00:05', kind: 'rdma_nocrc', detail: 'd', src: 'ip/src/rdma.cpp:9', suppressed: 101 },
      { type: 'incident_suppressed', ts: '10:00:09', kind: 'rdma_nocrc', detail: 'd', src: 'ip/src/rdma.cpp:9', suppressed: 201 },
    ];
    const p = parseDiag([{ name: 'x.jsonl', text: lines.map((l) => JSON.stringify(l)).join('\n') }]);
    expect(p.summary.incidents_by_kind).toEqual({ rdma_nocrc: 202 });
    expect(p.incidents).toHaveLength(1);
    expect(p.summary.first_ts).toBe('10:00:00'); // time-only stamps used when nothing is dated
  });
});

describe('INI', () => {
  const baseline = `# LCD CF Pattern
[Image]
width = 8160
height = 5000

[Pattern]
pitch_x = 26
fast_search_range = 1
enable_multiscale = 1
lsc_k1 = 0.15
removed_key = 3
`;
  const current = `\uFEFF[Image]\r\nwidth = 8160.0\r\nheight = 5000\r\n\r\n[pattern]\r\npitch_x = 26 ; same\r\nfast_search_range = 2\r\nenable_multiscale = 1\r\nlsc_k1 = .15\r\nnew_key = yes\r\n`;

  it('parseIni handles comments, BOM, CRLF, inline comments', () => {
    const f = parseIni('default_zone.ini', current);
    expect(f.sections.Image).toEqual({ width: '8160.0', height: '5000' });
    expect(f.sections.pattern!.pitch_x).toBe('26');
    expect(parseIni('b.ini', baseline).sections.Pattern!.lsc_k1).toBe('0.15');
  });

  it('iniDiff: changed fast_search_range 1→2, added key, removed key; numeric 1.0 == 1', () => {
    const d = iniDiff(parseIni('cur.ini', current), parseIni('base.ini', baseline));
    expect(d).toEqual([
      { section: 'pattern', key: 'fast_search_range', current: '2', baseline: '1' },
      { section: 'pattern', key: 'new_key', current: 'yes', baseline: null },
      { section: 'pattern', key: 'removed_key', current: null, baseline: '3' },
    ]);
  });

  it('parseDiag detects an INI input and names it in the summary', () => {
    const p = parseDiag([{ name: 'default_zone.ini', text: baseline }]);
    expect(p.ini).toHaveLength(1);
    expect(p.events).toHaveLength(0);
    expect(diagSummaryText(p)).toContain('default_zone.ini（2 個區段、7 個鍵）');
  });
});

describe('free-form text logs (mixed paste)', () => {
  const paste = [
    '2026-07-12 05:37:00 INFO start inspection',
    '[2026/07/12 05:37:10.123] ERROR grab timeout ERR_GRAB_TIMEOUT (code=1203)',
    '[2026/07/12 05:37:10.200] WARN queue depth 12 > 8',
    '05:37:11 warning: GPU temperature high',
    '2026-07-12 05:37:12.001 [AOI.Host] Unhandled exception',
    'System.InvalidOperationException: Camera not ready',
    '   at AOI.Host.Grabber.Start() in C:\\src\\AOI.Host\\Grabber.cs:line 45',
    '   at AOI.Host.Program.Main(String[] args) in C:\\src\\AOI.Host\\Program.cs:line 12',
    'Traceback (most recent call last):',
    '  File "tools/replay.py", line 30, in <module>',
    '    main()',
    '  File "tools/replay.py", line 12, in main',
    '    raise ValueError("bad pitch")',
    'ValueError: bad pitch',
    'MIL error: MdigGrab: Grab timeout. MIL error code: 123',
    '2026/07/12 05:37:20 告警 ALM0042 真空壓力異常',
    'control_server.cpp:407 parse failed',
    'nothing to see here',
    '{"type":"incident","ts":"2026-07-12T05:37:30.000","kind":"bad_json","detail":"x","src":"ip/src/control_server.cpp:407"}',
    '{ "broken": ',
  ].join('\r\n');
  const p = parseDiag([{ name: 'pasted', text: paste }]);
  const logs = p.events.filter((e) => e.type === 'log');
  const byLine = (n: number) => p.events.find((e) => e.line === n)!;

  it('extracts only the interesting lines, with levels and timestamps as written', () => {
    expect(logs.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 9, 15, 16, 17]);
    const grab = byLine(2);
    expect(grab).toMatchObject({ kind: 'ERROR', ts: '2026/07/12 05:37:10.123', input: 'pasted' });
    expect(grab.codes.sort()).toEqual(['ERR_GRAB_TIMEOUT', 'code=1203']);
    expect(byLine(3)).toMatchObject({ kind: 'WARN', ts: '2026/07/12 05:37:10.200' });
    expect(byLine(4)).toMatchObject({ kind: 'WARN', ts: '05:37:11' });
    expect(byLine(16)).toMatchObject({ kind: 'ALARM', ts: '2026/07/12 05:37:20' });
    expect(byLine(16).codes).toEqual(['ALM0042']);
    expect(p.summary.levels).toEqual({ ERROR: 3, WARN: 2, EXCEPTION: 3, ALARM: 1 });
  });

  it('C# stack trace frames attach to the exception line', () => {
    const cs = byLine(6);
    expect(cs.kind).toBe('EXCEPTION');
    expect(cs.src).toEqual([
      { file: 'C:/src/AOI.Host/Grabber.cs', line: 45, func: 'AOI.Host.Grabber.Start' },
      { file: 'C:/src/AOI.Host/Program.cs', line: 12, func: 'AOI.Host.Program.Main' },
    ]);
    expect(cs.raw).toContain('Program.cs:line 12');
  });

  it('Python traceback becomes one event, innermost frame first, detail = the exception line', () => {
    const py = byLine(9);
    expect(py.kind).toBe('EXCEPTION');
    expect(py.detail).toBe('ValueError: bad pitch');
    expect(py.src).toEqual([
      { file: 'tools/replay.py', line: 12, func: 'main' },
      { file: 'tools/replay.py', line: 30, func: '<module>' },
    ]);
  });

  it('MIL error code, bare file:line, embedded jsonl line, bad JSON warning', () => {
    expect(byLine(15)).toMatchObject({ kind: 'ERROR', codes: ['MIL:123'] });
    expect(byLine(17).src).toEqual([{ file: 'control_server.cpp', line: 407, func: null }]);
    expect(byLine(19)).toMatchObject({ type: 'incident', kind: 'bad_json' });
    expect(p.warnings).toEqual([]); // an unterminated "{ ..." is just text, not a warning
    expect(parseDiag([{ name: 'x', text: 'ok\n{"a": nope}\n' }]).warnings[0]).toContain('x:2');
  });

  it('errors = error-level logs + incidents; signature carries codes, exceptions, incidents', () => {
    expect(p.errors.map((e) => e.line)).toEqual([2, 5, 6, 9, 15, 16, 17, 19]);
    expect(p.signature).toEqual(
      expect.arrayContaining([
        'code:ERR_GRAB_TIMEOUT',
        'code:MIL:123',
        'exc:System.InvalidOperationException',
        'exc:ValueError',
        'incident:bad_json@ip/src/control_server.cpp',
        'src:C:/src/AOI.Host/Grabber.cs:45',
        'src:tools/replay.py:12',
      ]),
    );
    expect(p.signature.length).toBeLessThanOrEqual(30);
    const t = diagSummaryText(p, 1200);
    expect(t.length).toBeLessThanOrEqual(1200);
    expect(t).toContain('ERR_GRAB_TIMEOUT');
    expect(t).toContain('主要錯誤行');
  });

  it('pretty-printed JSON pasted inside text is still one event', () => {
    const q = parseDiag([{ name: 'p', text: 'see below\n{\n  "type": "incident",\n  "kind": "cuda_fatal",\n  "detail": "x"\n}\nERROR after' }]);
    expect(q.events.map((e) => [e.type, e.line])).toEqual([['incident', 2], ['log', 7]]);
  });
});

describe('robustness and size', () => {
  it('never throws on junk; empty and garbage inputs become warnings or nothing', () => {
    const junk: DiagInput[] = [
      { name: 'empty', text: '' },
      { name: 'big5', text: '\uFFFD\uFFFD\uFFFD 錯誤 \u0000\uFFFD\n[\n]]]\n{{{{' },
      { name: 'arr', text: '[1, 2, {"type":"session","ip_name":"IP02"}]' },
      // @ts-expect-error a caller passing nonsense
      { name: 'nonsense', text: null },
    ];
    const p = parseDiag(junk);
    expect(p.summary.inputs).toBe(4);
    expect(p.sessions.map((s) => s.ip_name)).toEqual(['IP02']);
    expect(p.events.some((e) => e.input === 'big5' && e.kind === 'ERROR')).toBe(true);
  });

  it('caps events at 2000 and keeps counting', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `ERROR thing ${i}`).join('\n');
    const p = parseDiag([{ name: 'big', text }]);
    expect(p.events).toHaveLength(2000);
    expect(p.summary.levels.ERROR).toBe(3000);
    expect(p.warnings.join()).toContain('2000');
    expect(diagSummaryText(p).length).toBeLessThanOrEqual(4000);
  });

  it('parses a 50k-line log in under 1 s', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) {
      const t = `2026/07/12 05:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}`;
      if (i % 10 === 0) lines.push(`[${t}] ERROR grab timeout ERR_GRAB_TIMEOUT (code=${1200 + (i % 7)}) at ip/src/grab.cpp:${i % 50}`);
      else if (i % 10 === 1) lines.push(`[${t}] WARN queue depth ${i % 30}`);
      else if (i % 100 === 2) lines.push(JSON.stringify({ type: 'incident', ts: t, kind: 'bad_json', detail: `d${i}`, src: 'ip/src/control_server.cpp:407' }));
      else lines.push(`[${t}] INFO frame ${i} processed in ${i % 17}.3 ms panel=frv2 zone0 defects=${i % 5}`);
    }
    const text = lines.join('\n');
    const t0 = performance.now();
    const p = parseDiag([{ name: 'app.log', text }]);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    expect(p.summary.levels.ERROR).toBe(5000);
    expect(p.summary.incidents_by_kind.bad_json).toBe(500);
    expect(p.summary.codes.ERR_GRAB_TIMEOUT).toBe(5000);
    expect(diagSummaryText(p).length).toBeLessThanOrEqual(4000);
  });
});
