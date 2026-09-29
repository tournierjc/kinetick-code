import { describe, expect, it } from 'vitest';

import { isMetadataOrLinkLocalHostname, readRemoteAssetSource } from '../../src/assets/remote-source.js';
import { LocalWebFetchClient } from '../../src/web-fetch/local-web-fetch-client.js';

describe('fetch address profile', () => {
  it('classifies link-local and metadata names, and leaves loopback alone', () => {
    expect(isMetadataOrLinkLocalHostname('169.254.169.254')).toBe(true);
    expect(isMetadataOrLinkLocalHostname('metadata.google.internal')).toBe(true);
    expect(isMetadataOrLinkLocalHostname('fe80::1')).toBe(true);
    expect(isMetadataOrLinkLocalHostname('127.0.0.1')).toBe(false);
    expect(isMetadataOrLinkLocalHostname('localhost')).toBe(false);
    expect(isMetadataOrLinkLocalHostname('10.0.0.5')).toBe(false);
  });

  it('refuses a metadata address before web_fetch opens a socket', async () => {
    const client = new LocalWebFetchClient({
      fetchImpl: async () => {
        throw new Error('socket opened');
      },
    });
    const result = await client.fetch({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result.retrievalOutcome).toBe('invalid_request');
    expect(result.content).toContain('link-local');
  });

  it('refuses a redirect onto a metadata address', async () => {
    const client = new LocalWebFetchClient({
      fetchImpl: async (input) => {
        const href = String(input);
        if (href.includes('169.254.169.254')) throw new Error('socket opened');
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      },
    });
    const result = await client.fetch({ url: 'https://example.com/start' });
    expect(result.retrievalOutcome).toBe('invalid_request');
  });

  it('still fetches a loopback web_fetch URL', async () => {
    const client = new LocalWebFetchClient({
      fetchImpl: async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const result = await client.fetch({ url: 'http://127.0.0.1:9/health' });
    expect(result.retrievalOutcome).toBe('usable_content');
    expect(result.content).toBe('ok');
  });

  it('rejects a skill-archive URL that is not public https', async () => {
    await expect(
      readRemoteAssetSource({ url: 'https://169.254.169.254/skill.zip', maxBytes: 128 }),
    ).rejects.toThrow('asset_remote_url_invalid');
    await expect(
      readRemoteAssetSource({ url: 'http://127.0.0.1/skill.zip', maxBytes: 128 }),
    ).rejects.toThrow('asset_remote_url_invalid');
  });
});
