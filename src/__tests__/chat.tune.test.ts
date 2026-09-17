import { describe, it, expect } from 'vitest';
import { parseTuneBlock, plainTaskInput, tuneGoal, tuneTaskInput } from '../chat/tune.js';

/**
 * 調參建議 parsing. The local model is not reliable about output formats, so the rule is: anything
 * unusable returns null and the page falls back to showing an ordinary answer.
 */

const block = (json: string) => `先說明一下判斷。\n\n\`\`\`loop-tune\n${json}\n\`\`\`\n`;
const good = JSON.stringify({
  symptom: 'ROI 邊緣常把正常紋路判成刮傷',
  suggestions: [
    { file: 'ip/src/defect.cpp', param: 'edge_margin_px', current: '4', proposed: '8', why: '邊緣梯度大', risk: 'low', verify: '用 20 張誤判圖重跑' },
  ],
});

describe('parseTuneBlock', () => {
  it('pulls the block out of a normal answer', () => {
    const card = parseTuneBlock(block(good))!;
    expect(card.symptom).toBe('ROI 邊緣常把正常紋路判成刮傷');
    expect(card.suggestions).toHaveLength(1);
    expect(card.suggestions[0]).toMatchObject({ file: 'ip/src/defect.cpp', param: 'edge_margin_px', current: '4', proposed: '8', risk: 'low' });
  });

  it('tolerates the language tag the model sometimes adds', () => {
    expect(parseTuneBlock(`\`\`\`loop-tune json\n${good}\n\`\`\``)).not.toBeNull();
  });

  it('returns null for anything unusable instead of throwing', () => {
    expect(parseTuneBlock('沒有區塊的普通回答')).toBeNull();
    expect(parseTuneBlock(block('{ not json'))).toBeNull();
    expect(parseTuneBlock(block('{"symptom":"x"}'))).toBeNull(); // no suggestions
    expect(parseTuneBlock(block('{"suggestions":[]}'))).toBeNull();
    expect(parseTuneBlock(block('{"suggestions":[{"why":"缺 file/param/proposed"}]}'))).toBeNull();
    expect(parseTuneBlock('')).toBeNull();
  });

  it('takes the first block only, so a chatty model cannot smuggle a second table in', () => {
    const two = `${block(good)}\n${block(JSON.stringify({ symptom: '第二個', suggestions: [{ file: 'a', param: 'b', proposed: 'c' }] }))}`;
    expect(parseTuneBlock(two)!.symptom).toBe('ROI 邊緣常把正常紋路判成刮傷');
  });

  it('normalises risk and the missing current value', () => {
    const card = parseTuneBlock(
      block(
        JSON.stringify({
          symptom: 's',
          suggestions: [
            { file: 'a.cpp', param: 'p1', proposed: '1', risk: 'HIGH' },
            { file: 'a.cpp', param: 'p2', proposed: '2', risk: '很危險' },
            { file: 'a.cpp', param: 'p3', proposed: '3', current: null },
          ],
        }),
      ),
    )!;
    expect(card.suggestions.map((s) => s.risk)).toEqual(['high', 'medium', 'medium']);
    expect(card.suggestions.every((s) => s.current === null)).toBe(true);
  });

  it('caps a runaway list and over-long fields', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ file: 'a.cpp', param: `p${i}`, proposed: 'x'.repeat(900) }));
    const card = parseTuneBlock(block(JSON.stringify({ symptom: 'y'.repeat(900), suggestions: many })))!;
    expect(card.suggestions).toHaveLength(20);
    expect(card.symptom.length).toBe(400);
    expect(card.suggestions[0]!.proposed.length).toBe(400);
  });
});

describe('tuneTaskInput', () => {
  const card = parseTuneBlock(block(good))!;

  it('produces a draft task that carries the table and refuses to imply it was applied', () => {
    const input = tuneTaskInput(card, { messageId: 'm_1', conversationTitle: '刮傷誤判', owner: '呂侑儒' });
    expect(input.title).toContain('調參建議');
    expect(input.created_by).toBe('chat');
    expect(input.source_ref).toBe('chat:m_1'); // idempotency key for the route
    expect(input.verify_mode).toBe('manual');
    expect(input.owner).toBe('呂侑儒');
    expect(input.goal).toContain('ip/src/defect.cpp');
    expect(input.goal).toContain('edge_margin_px');
    expect(input.goal).toContain('不得自動套用到機台');
    expect(input.verify_rubric).toContain('用 20 張誤判圖重跑');
  });

  it('marks a value the knowledge base does not state, rather than inventing one', () => {
    const noCurrent = parseTuneBlock(block(JSON.stringify({ symptom: 's', suggestions: [{ file: 'a.cpp', param: 'p', proposed: '9' }] })))!;
    expect(tuneGoal(noCurrent)).toContain('（知識庫未記載）');
  });

  it('falls back to a plain task for an answer with no suggestion block', () => {
    const input = plainTaskInput({ content: '把 RDMA 收圖改回 SEND/RECV', conversationTitle: 'RDMA', messageId: 'm_2' });
    expect(input.source_ref).toBe('chat:m_2');
    expect(input.created_by).toBe('chat');
    expect(input.goal).toContain('把 RDMA 收圖改回 SEND/RECV');
    expect(input.title.length).toBeLessThanOrEqual(120);
  });
});
