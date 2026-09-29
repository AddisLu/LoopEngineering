/**
 * Is the user's reply a plain "yes"? The model decides WHEN to call ops_confirm; this is the
 * server's check that the person's latest message really agreed, so a stray 「好」 in a longer
 * sentence, a question, or a 「好，但改成…」 never runs anything.
 *
 * Deliberately strict: after the action code and punctuation are removed the reply must be short,
 * contain a yes-word, and carry no negation, change or question. Anything else means "prepare it
 * again" — cheap for the person, and never a wrong run.
 */

const YES = /確認|確定|好|可以|行|對|是|同意|沒問題|没问题|開始|开始|執行|执行|照做|嗯|ok|yes|yep|sure|go/i;
// negation, hesitation or a change of plan
const NO = /不|別|别|等|取消|停|改|換|换|但|不過|不过|除了|還是|还是|算了|先別|no|wait|cancel|change|stop|dont|don't/i;
// a question or a request for something else, not an answer
const ASKING = /嗎|吗|呢|一下|看看|查|問|问|什麼|什么|怎麼|怎么|為什麼|为什么|如何|哪|多少|幾|几/;
// affirmative phrases that happen to contain a 不／問 character
const SAFE = /沒問題|没问题|沒錯|没错|不錯|不错/g;
const MAX_CHARS = 12;

export interface ReplyClass {
  affirmative: boolean;
  hasCode: boolean;
  /** why it is not a plain yes, in the user's words (null when affirmative) */
  reason: string | null;
}

export function classifyReply(text: string, code: string): ReplyClass {
  const norm = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
  const c = String(code ?? '').toLowerCase();
  const hasCode = c.length > 0 && new RegExp(`(^|[^a-z0-9])${c.replace(/[^a-z0-9]/g, '')}([^a-z0-9]|$)`).test(norm);
  if (/[?？]/.test(norm)) return { affirmative: false, hasCode, reason: '回覆是問句，不是同意' };
  const rest = (c ? norm.split(c).join(' ') : norm).replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!rest) return { affirmative: false, hasCode, reason: '回覆裡沒有同意的字' };
  if (rest.length > MAX_CHARS) return { affirmative: false, hasCode, reason: '回覆不只是同意（太長）' };
  const plain = rest.replace(SAFE, '好');
  if (NO.test(plain)) return { affirmative: false, hasCode, reason: '回覆裡有否定、等待或修改' };
  if (ASKING.test(plain)) return { affirmative: false, hasCode, reason: '回覆是在問問題，不是同意' };
  if (!YES.test(plain)) return { affirmative: false, hasCode, reason: '回覆裡沒有同意的字' };
  return { affirmative: true, hasCode, reason: null };
}
