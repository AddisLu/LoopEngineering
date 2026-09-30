/**
 * A branch as a person names it — never an option (`--force`), a force marker (`+main`), a
 * refspec (`a:b`) or anything git would not accept as a branch. `origin/main` is fine (merge).
 * Shared by 對話操作 (src/chatops/git.ts) and the repo registry (src/repo/store.ts).
 */
export const BRANCH_RE = /^(?![-+./])(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|[./]$))[A-Za-z0-9._/-]{1,200}$/;
export const validBranch = (b: string): boolean => BRANCH_RE.test(b);
