/**
 * Is the user's reply a plain "yes"? The model decides WHEN to call ops_confirm; this is the
 * server's check that the person's latest message really agreed, so a stray 「好」 in a longer
 * sentence, a question, or a 「好，但改成…」 never runs anything.
 *
 * Deliberately strict: after the action's own code is removed, every word must be a yes-word or a
 * particle, with no negation, change or question. Anything else means "prepare it again" — cheap
 * for the person, and never a wrong run.
 */

// negation, hesitation or a change of plan
const NO = /不|別|别|等|取消|停|改|換|换|但|不過|不过|除了|還是|还是|算了|先別|no|wait|cancel|change|stop|dont|don't/i;
// a question or a request for something else, not an answer
const ASKING = /嗎|吗|呢|一下|看看|查|問|问|什麼|什么|怎麼|怎么|為什麼|为什么|如何|哪|多少|幾|几/;
// affirmative phrases that happen to contain a 不／問 character
const SAFE = /沒問題|没问题|沒錯|没错|不錯|不错/g;

/**
 * Every word of a plain yes must be one of these: a yes-word (at least one), or a particle people
 * wrap it in. Anything else — another action's code, a task id, one more word — means the reply
 * says more than yes. Chinese runs are peeled from the front, longest word first; English words
 * are whole tokens (「google it」 is not 「go」).
 */
const CJK_YES = ['確認', '确认', '確定', '确定', '同意', '可以', '開始', '开始', '執行', '执行', '照做', '就這樣', '就这样', '沒問題', '没问题', '沒錯', '没错', '好', '行', '對', '对', '是', '嗯', '讚', '赞'];
const CJK_FILLER = ['麻煩', '麻烦', '謝謝', '谢谢', '感謝', '感谢', '那就', '的', '啊', '喔', '哦', '吧', '了', '啦', '呀', '囉', '咯', '唷', '耶', '請', '请', '那', '就'];
const CJK_WORDS = [...CJK_YES, ...CJK_FILLER].sort((a, b) => b.length - a.length);
const EN_YES = new Set(['ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'go', 'confirm', 'confirmed', 'y']);
const EN_FILLER = new Set(['please', 'pls', 'ahead', 'thanks', 'thx']);

export interface ReplyClass {
  affirmative: boolean;
  hasCode: boolean;
  /** why it is not a plain yes, in the user's words (null when affirmative) */
  reason: string | null;
}

const no = (hasCode: boolean, reason: string): ReplyClass => ({ affirmative: false, hasCode, reason });

export function classifyReply(text: string, code: string): ReplyClass {
  const norm = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
  const c = String(code ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const codeRe = c ? new RegExp(`(^|[^a-z0-9])${c}(?=[^a-z0-9]|$)`, 'g') : null;
  const hasCode = Boolean(codeRe && codeRe.test(norm));
  if (/[?？]/.test(norm)) return no(hasCode, '回覆是問句，不是同意');
  const plain = norm.replace(SAFE, '好');
  if (NO.test(plain)) return no(hasCode, '回覆裡有否定、等待或修改');
  if (ASKING.test(plain)) return no(hasCode, '回覆是在問問題，不是同意');
  // the action's own code is allowed anywhere; everything else must be a yes-word or a particle
  const rest = codeRe ? plain.replace(codeRe, '$1 ') : plain;
  const runs = rest.match(/[a-z0-9_]+|[^\sa-z0-9_\p{P}\p{S}]+/gu) ?? [];
  let yes = false;
  for (const run of runs) {
    if (/^[a-z0-9_]+$/.test(run)) {
      if (EN_YES.has(run)) yes = true;
      else if (!EN_FILLER.has(run)) {
        if (/^(t|b|oa)_/.test(run)) return no(hasCode, '回覆提到另一個任務或評比，不是單純同意');
        if (/^[a-z0-9]{3}$/.test(run)) return no(hasCode, `回覆裡的代碼不是這個動作的${c ? `（這個動作是 ${c.toUpperCase()}）` : ''}`);
        return no(hasCode, '回覆不只是同意');
      }
      continue;
    }
    let left = run;
    while (left) {
      const w = CJK_WORDS.find((x) => left.startsWith(x));
      if (!w) return no(hasCode, '回覆不只是同意');
      if (CJK_YES.includes(w)) yes = true;
      left = left.slice(w.length);
    }
  }
  if (!yes) return no(hasCode, '回覆裡沒有同意的字');
  return { affirmative: true, hasCode, reason: null };
}
