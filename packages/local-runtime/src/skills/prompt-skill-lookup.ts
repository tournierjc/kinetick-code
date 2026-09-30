/**
 * Prompt-conditioned Skill lookup. Scores catalog entries against the latest
 * user prompt using token overlap on name + description. Callers apply the
 * session Skill policy with `applyPromptSkillSessionPolicy` before matching so
 * forbidden Skills are not advertised.
 */

export interface PromptSkillCandidate {
  readonly name: string;
  readonly description?: string;
  readonly disposition?: 'mandatory' | 'optional';
}

/** Session Skill policy as seen by prompt matching. Names are matched case-insensitively. */
export interface PromptSkillSessionPolicy {
  readonly dispositions: Readonly<Record<string, 'mandatory' | 'optional' | 'forbidden'>>;
  readonly closed: boolean;
}

/**
 * Drop forbidden and closed-catalog Skills, and stamp mandatory/optional from
 * the session policy so prompt matching can prefer mandatory Skills.
 * Without a policy, candidates pass through unchanged.
 */
export function applyPromptSkillSessionPolicy(
  candidates: readonly PromptSkillCandidate[],
  policy: PromptSkillSessionPolicy | undefined,
): PromptSkillCandidate[] {
  if (!policy) return [...candidates];
  const selected: PromptSkillCandidate[] = [];
  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (!name) continue;
    const disposition = promptSkillDisposition(policy, name);
    if (disposition === 'forbidden' || disposition === 'hidden') continue;
    selected.push({
      name,
      ...(candidate.description ? { description: candidate.description } : {}),
      disposition: disposition === 'mandatory' ? 'mandatory' : 'optional',
    });
  }
  return selected;
}

function promptSkillDisposition(
  policy: PromptSkillSessionPolicy,
  skillName: string,
): 'mandatory' | 'optional' | 'forbidden' | 'hidden' {
  const key = skillName.normalize('NFKC').toLocaleLowerCase('en-US');
  if (!Object.prototype.hasOwnProperty.call(policy.dispositions, key)) {
    return policy.closed ? 'hidden' : 'optional';
  }
  const explicit = policy.dispositions[key];
  if (explicit === 'mandatory' || explicit === 'optional' || explicit === 'forbidden') {
    return explicit;
  }
  return policy.closed ? 'hidden' : 'optional';
}

export interface PromptSkillMatch {
  readonly name: string;
  readonly score: number;
  readonly disposition: 'mandatory' | 'optional';
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'please',
  'that',
  'the',
  'this',
  'to',
  'with',
  'you',
  'your',
]);

export function tokenizePromptLookupText(text: string): string[] {
  return text
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9_+.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function matchSkillsForPrompt(
  prompt: string,
  candidates: readonly PromptSkillCandidate[],
  options: { readonly limit?: number; readonly minScore?: number } = {},
): PromptSkillMatch[] {
  const tokens = new Set(tokenizePromptLookupText(prompt));
  if (tokens.size === 0 || candidates.length === 0) return [];
  const minScore = options.minScore ?? 1;
  const limit = options.limit ?? 5;
  const scored: PromptSkillMatch[] = [];
  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (!name) continue;
    const haystack = tokenizePromptLookupText(`${name} ${candidate.description ?? ''}`);
    if (haystack.length === 0) continue;
    let score = 0;
    for (const token of haystack) {
      if (tokens.has(token)) score += token === name.toLocaleLowerCase('en-US') ? 3 : 1;
    }
    // Exact substring boost when the skill name appears in the prompt.
    if (prompt.toLocaleLowerCase('en-US').includes(name.toLocaleLowerCase('en-US'))) {
      score += 4;
    }
    if (candidate.disposition === 'mandatory') score += 2;
    if (score < minScore) continue;
    scored.push({
      name,
      score,
      disposition: candidate.disposition === 'mandatory' ? 'mandatory' : 'optional',
    });
  }
  return scored
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function formatPromptSkillMatchReminder(matches: readonly PromptSkillMatch[]): string {
  if (matches.length === 0) return '';
  const lines = matches.map((match) => {
    const tag = match.disposition === 'mandatory' ? 'mandatory' : 'matched';
    return `- ${match.name} (${tag})`;
  });
  return [
    'The following Skills appear relevant to the latest user prompt.',
    'Load a Skill with the `skill` tool before following its instructions.',
    ...lines,
  ].join('\n');
}
