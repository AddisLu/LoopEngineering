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

/** True when `s` appears (normalized) in one of the person's messages. */
export function saidByUser(texts: string[], s: string): boolean {
  const needle = normalizeSaid(s);
  if (!needle) return false;
  return texts.some((t) => normalizeSaid(t).includes(needle));
}

/** The items the person did not say (empty = all of them were). */
export function unsaid(texts: string[], items: string[]): string[] {
  return items.filter((x) => !saidByUser(texts, x));
}
