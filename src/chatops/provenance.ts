import type Database from 'better-sqlite3';

/**
 * "Did the person say this?" — verification commands, clone URLs and spike URLs the chat model
 * hands to a preparer must appear in the person's own messages of this conversation. A model that
 * fills a gap with a plausible `npm test` gets told to ask instead.
 */

/** The live user messages of a conversation, oldest first. */
export function userTexts(db: Database.Database, conversationId: string): string[] {
  return (
    db
      .prepare("SELECT content FROM chat_messages WHERE conversation_id = ? AND role = 'user' AND invalid_at IS NULL ORDER BY ord ASC")
      .all(conversationId) as Array<{ content: string }>
  ).map((r) => r.content ?? '');
}

/** Comparable form: NFKC, straight quotes, one space, no surrounding backticks. */
export function normalizeSaid(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Characters that continue a command or a URL: a match next to one of these is only part of something longer. */
const CONT_BEFORE = /[A-Za-z0-9_\-./~$=+:@]/;
const CONT_AFTER = /[A-Za-z0-9_\-./~=+:@]/;

/**
 * `needle` occurs in `text` as a whole word-ish unit — not in the middle of a longer command or
 * URL, and (for commands) not followed by more options (`make deploy --force` is not `make deploy`).
 */
function atBoundary(text: string, needle: string, command = false): boolean {
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    const before = i === 0 ? '' : text[i - 1]!;
    const after = text[i + needle.length] ?? '';
    if (CONT_BEFORE.test(before) || CONT_AFTER.test(after)) continue;
    if (command && /^ +-/.test(text.slice(i + needle.length))) continue;
    return true;
  }
  return false;
}

/** True when `s` appears (normalized) in one of the person's messages, as a whole unit — for URLs. */
export function saidByUser(texts: string[], s: string): boolean {
  const needle = normalizeSaid(s);
  if (!needle) return false;
  return texts.some((t) => atBoundary(normalizeSaid(t), needle));
}

/** A typed instruction is short; longer messages are pasted logs, READMEs and chat excerpts. */
const TYPED_MAX = 200;

/**
 * True when the person gave `cmd` as a command: the whole of a line, a `code` span or a quoted
 * span of their message — or, in a short typed instruction (「驗證就跑 npm test 吧」), a whole unit
 * of it. A command that only sits inside a longer line of a pasted log or README does not count:
 * the model must not lift one out of text the person pasted for another reason.
 */
export function commandSaidByUser(texts: string[], cmd: string): boolean {
  const needle = normalizeSaid(cmd);
  if (!needle) return false;
  return texts.some((raw) => {
    const spans = [...raw.matchAll(/`([^`\n]+)`|「([^」\n]+)」|“([^”\n]+)”|"([^"\n]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
    const lines = raw.split('\n').map((l) => l.replace(/^\s*(?:[-*>$#]|\d+[.)])\s+/, ''));
    if ([...spans, ...lines].some((x) => normalizeSaid(x) === needle)) return true;
    const text = normalizeSaid(raw);
    return text.length <= TYPED_MAX && atBoundary(text, needle, true);
  });
}

/** The URLs the person did not say (empty = all of them were). */
export function unsaid(texts: string[], items: string[]): string[] {
  return items.filter((x) => !saidByUser(texts, x));
}

/** The commands the person did not give (empty = all of them were). */
export function unsaidCommands(texts: string[], items: string[]): string[] {
  return items.filter((x) => !commandSaidByUser(texts, x));
}
