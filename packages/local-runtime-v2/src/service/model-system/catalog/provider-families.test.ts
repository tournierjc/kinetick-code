import { describe, expect, it } from 'vitest';

import { PROVIDER_FAMILIES, providerFamilyForLookup } from './provider-families.js';

describe('provider families', () => {
  it('declares the DeepSeek endpoint contract', () => {
    const deepseek = PROVIDER_FAMILIES.find((family) => family.providerId === 'deepseek');

    expect(deepseek).toMatchObject({
      displayName: 'DeepSeek',
      hosts: ['api.deepseek.com'],
      apiFormat: 'openai-completions',
      thinkingFormat: 'deepseek',
      effortOptions: ['low', 'medium', 'high', 'max'],
      pinned: true,
    });
    // The V4 API takes a `thinking` object, so the family has to say so: a bare
    // `reasoning_effort` cannot express "thinking off" there.
    expect(deepseek?.thinkingFormat).not.toBe('openai');
  });

  it('resolves a family from the provider key, the endpoint, or the model id', () => {
    expect(providerFamilyForLookup({ providerId: 'deepseek' })?.providerId).toBe('deepseek');
    // A provider named anything at all still belongs to DeepSeek's endpoint.
    expect(
      providerFamilyForLookup({ providerId: 'work', baseUrl: 'https://api.deepseek.com' })
        ?.providerId,
    ).toBe('deepseek');
    expect(
      providerFamilyForLookup({ providerId: 'work', baseUrl: 'https://api.deepseek.com/v1' })
        ?.providerId,
    ).toBe('deepseek');
    // An echo server configured under the provider's own name is still DeepSeek
    // for the purpose of the request shape.
    expect(
      providerFamilyForLookup({ providerId: 'deepseek', baseUrl: 'http://127.0.0.1:8788/v1' })
        ?.providerId,
    ).toBe('deepseek');
    expect(providerFamilyForLookup({ providerId: 'work', modelId: 'deepseek-v4-pro' })?.providerId).toBe(
      'deepseek',
    );
  });

  it('leaves providers and generations it does not know alone', () => {
    expect(providerFamilyForLookup({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBeUndefined();
    expect(providerFamilyForLookup({ providerId: 'work', modelId: 'gpt-5-mini' })).toBeUndefined();
    expect(providerFamilyForLookup({})).toBeUndefined();
    // A host that merely contains the family's hostname is not the family.
    expect(
      providerFamilyForLookup({ providerId: 'work', baseUrl: 'https://notdeepseek.example' }),
    ).toBeUndefined();
  });
});
