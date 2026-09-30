import { describe, expect, it } from 'vitest';

import {
  AgentFrameworkType,
  buildPromptSkillMatchBlock,
  buildRelevantMemoryBlock,
  createDefaultRegistry,
  promptSkillMatchProvider,
  relevantMemoryProvider,
} from '../../src/index.js';

describe('prompt skill and memory reminder providers', () => {
  it('builds and injects relevant memory blocks', () => {
    const text = 'Preferred deploy target is staging.';
    expect(buildRelevantMemoryBlock(text)).toContain('<relevant-memory>');
    expect(relevantMemoryProvider({ relevantMemory: text } as never)).toContain(text);
    expect(relevantMemoryProvider({} as never)).toBeUndefined();
  });

  it('builds and injects prompt skill match blocks', () => {
    const text = '- pdf (matched)';
    expect(buildPromptSkillMatchBlock(text)).toContain('<prompt-skill-match>');
    expect(promptSkillMatchProvider({ promptSkillMatch: text } as never)).toContain(text);
    expect(promptSkillMatchProvider({} as never)).toBeUndefined();
  });

  it('registers both providers in the default registry', () => {
    const registry = createDefaultRegistry(() => 'now');
    const names = registry.resolve(AgentFrameworkType.PiAgent).map((entry) => entry.name);
    expect(names).toContain('relevantMemoryProvider');
    expect(names).toContain('promptSkillMatchProvider');
  });
});
