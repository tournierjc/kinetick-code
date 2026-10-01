/**
 * Prompt-conditioned Memory lookup. Selects short excerpts from Memory text
 * that share tokens with the latest user prompt.
 */

import { tokenizePromptLookupText } from '../skills/prompt-skill-lookup.js';

export interface PromptMemoryMatch {
  readonly excerpt: string;
  readonly score: number;
  readonly source: string;
}

export function matchMemoryForPrompt(
  prompt: string,
  sources: readonly { readonly source: string; readonly content: string }[],
  options: { readonly limit?: number; readonly maxChars?: number; readonly minScore?: number } = {},
): PromptMemoryMatch[] {
  const tokens = new Set(tokenizePromptLookupText(prompt));
  if (tokens.size === 0) return [];
  const limit = options.limit ?? 4;
  const maxChars = options.maxChars ?? 900;
  const minScore = options.minScore ?? 2;
  const matches: PromptMemoryMatch[] = [];

  for (const source of sources) {
    const content = source.content.trim();
    if (!content) continue;
    for (const paragraph of splitMemoryParagraphs(content)) {
      const haystack = tokenizePromptLookupText(paragraph);
      let score = 0;
      for (const token of haystack) {
        if (tokens.has(token)) score += 1;
      }
      if (score < minScore) continue;
      matches.push({
        source: source.source,
        score,
        excerpt: truncateExcerpt(paragraph, Math.ceil(maxChars / limit)),
      });
    }
  }

  const selected: PromptMemoryMatch[] = [];
  let used = 0;
  for (const match of matches.sort(
    (left, right) => right.score - left.score || left.source.localeCompare(right.source),
  )) {
    if (selected.length >= limit) break;
    if (used + match.excerpt.length > maxChars) continue;
    selected.push(match);
    used += match.excerpt.length;
  }
  return selected;
}

export function formatPromptMemoryLookup(matches: readonly PromptMemoryMatch[]): string {
  if (matches.length === 0) return '';
  return matches
    .map((match) => `[${match.source}]\n${match.excerpt}`)
    .join('\n\n');
}

function splitMemoryParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 24);
}

function truncateExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
