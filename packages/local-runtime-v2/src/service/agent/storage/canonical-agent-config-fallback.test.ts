import { describe, expect, it } from 'vitest';

import { parseCanonicalAgentMarkdown } from './canonical-agent-config.js';

function agentMarkdown(xMavis: string): string {
  return `---
name: chainbot
description: fallback-chain test agent
model: anthropic/claude-opus
x-mavis:
${xMavis}
---

# Body
`;
}

describe('canonical agent config — x-mavis.fallbackModels', () => {
  it('parses a provider/model list', () => {
    const parsed = parseCanonicalAgentMarkdown(
      agentMarkdown(`  fallbackModels:
    - openai/gpt-5.2
    - google/gemini-3-pro`),
      'chainbot',
    );
    expect(parsed.xMavis?.fallbackModels).toEqual(['openai/gpt-5.2', 'google/gemini-3-pro']);
  });

  it('drops duplicates, keeps first occurrence', () => {
    const parsed = parseCanonicalAgentMarkdown(
      agentMarkdown(`  fallbackModels:
    - openai/gpt-5.2
    - openai/gpt-5.2`),
      'chainbot',
    );
    expect(parsed.xMavis?.fallbackModels).toEqual(['openai/gpt-5.2']);
  });

  it('is undefined when absent', () => {
    const parsed = parseCanonicalAgentMarkdown(
      `---
name: plain
description: no mavis chains here
model: anthropic/claude-opus
---

# Body
`,
      'plain',
    );
    expect(parsed.xMavis?.fallbackModels).toBeUndefined();
  });

  it('rejects malformed entries (no provider prefix)', () => {
    expect(() =>
      parseCanonicalAgentMarkdown(
        agentMarkdown(`  fallbackModels:
    - gpt-only`),
        'chainbot',
      ),
    ).toThrow(/provider\/model/u);
  });

  it('rejects a non-array value', () => {
    expect(() =>
      parseCanonicalAgentMarkdown(agentMarkdown(`  fallbackModels: openai/gpt-5.2`), 'chainbot'),
    ).toThrow(/array/u);
  });

  it('caps the chain at three entries', () => {
    expect(() =>
      parseCanonicalAgentMarkdown(
        agentMarkdown(`  fallbackModels:
    - a/m1
    - b/m2
    - c/m3
    - d/m4`),
        'chainbot',
      ),
    ).toThrow(/at most 3/u);
  });
});
