import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPublicAddress } from '../../../src/connectors/web/address.js';
import { fakeLookup } from './helpers.js';

const PRIVATE = [
  '127.0.0.1',
  '127.255.255.255',
  '10.0.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.10.10',
  '100.64.0.1',
  '100.127.255.255',
  '0.0.0.0',
  '0.12.34.56',
  '224.0.0.1',
  '239.1.1.1',
  '::',
  '::1',
  'fe80::1',
  'fc00::1',
  'fd12:3456::1',
  'ff02::1',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.7',
  '::ffff:192.168.1.1',
];

const PUBLIC = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.255.255', '100.128.0.0', '2606:4700::1111', '::ffff:8.8.8.8'];

describe('isPublicAddress', () => {
  it.each(PRIVATE)('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(PUBLIC)('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('refuses things that are not addresses', () => {
    expect(isPublicAddress('example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('accepts a public host and asks DNS for it', async () => {
    const lookup = fakeLookup(['93.184.216.34']);
    await expect(assertPublicUrl(new URL('https://example.com/a'), lookup)).resolves.toBeUndefined();
    expect(lookup.calls).toEqual(['example.com']);
  });

  it('refuses loopback, private and local names before DNS', async () => {
    const lookup = fakeLookup(['93.184.216.34']);
    for (const address of [
      'http://localhost:8080/',
      'http://app.localhost/',
      'http://printer.local/',
      'http://nas.internal/',
      'http://router.home.arpa/',
      'http://127.0.0.1/',
      'http://[::1]/',
    ]) {
      await expect(assertPublicUrl(new URL(address), lookup)).rejects.toThrow();
    }
    expect(lookup.calls).toEqual([]);
  });

  it('refuses a name that resolves to a private address', async () => {
    const lookup = fakeLookup(['93.184.216.34', '10.0.0.5']);
    await expect(assertPublicUrl(new URL('https://example.com/'), lookup)).rejects.toThrow('not allowed');
  });

  it('refuses a name with no DNS answers', async () => {
    await expect(assertPublicUrl(new URL('https://example.com/'), fakeLookup([]))).rejects.toThrow();
  });

  it('refuses unsupported schemes and credentials', async () => {
    const lookup = fakeLookup(['93.184.216.34']);
    await expect(assertPublicUrl(new URL('ftp://example.com/x'), lookup)).rejects.toThrow();
    await expect(assertPublicUrl(new URL('https://user:pass@example.com/'), lookup)).rejects.toThrow();
  });

  it('never echoes the URL or its query string in an error', async () => {
    try {
      await assertPublicUrl(new URL('http://localhost/private?token=abc123'), fakeLookup([]));
      expect.fail('expected a refusal');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('abc123');
      expect(message).not.toContain('localhost');
    }
  });
});
