import { describe, it, expect } from 'vitest';
import { buildClaudeArgs } from '../orchestrator/adapters/claudeCode.js';
import { validateSetting } from '../settings.js';
import { DEFAULT_SETTINGS } from '../config.js';
import type { DispatchContext } from '../orchestrator/adapters/types.js';

function ctx(model: string | null): DispatchContext {
  return { model, resume: false, resumeSessionId: null } as unknown as DispatchContext;
}

describe('model selection', () => {
  it('passes --model to the CLI when a model is set', () => {
    expect(buildClaudeArgs(ctx('sonnet'))).toContain('--model');
    const a = buildClaudeArgs(ctx('sonnet'));
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('omits --model for null / default (uses the CLI default)', () => {
    expect(buildClaudeArgs(ctx(null))).not.toContain('--model');
    expect(buildClaudeArgs(ctx('default'))).not.toContain('--model');
  });

  it('default_model defaults to sonnet (keeps autonomous coding off the costly default)', () => {
    expect(DEFAULT_SETTINGS.default_model).toBe('sonnet');
  });

  it('validates default_model against the accepted aliases', () => {
    expect(validateSetting('default_model', 'sonnet')).toBeNull();
    expect(validateSetting('default_model', 'haiku')).toBeNull();
    expect(validateSetting('default_model', '')).toBeNull(); // CLI default
    expect(validateSetting('default_model', 'gpt-4')).toMatch(/default_model must be/);
  });
});
