import { afterEach, describe, expect, it } from 'vitest';
import { decryptMetaAdsToken, encryptMetaAdsToken } from '../meta-ads-credentials';

describe('encrypted scheduled Meta Ads credentials', () => {
 const previous = process.env.NEXTAUTH_SECRET;
 afterEach(() => { if (previous == null) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = previous; });
 it('encrypts tokens with fresh nonces and decrypts them only server-side', () => {
  process.env.NEXTAUTH_SECRET = 'test-only-nextauth-secret-with-sufficient-length';
  const first = encryptMetaAdsToken('synthetic-token'), second = encryptMetaAdsToken('synthetic-token');
  expect(first.token_ciphertext).not.toContain('synthetic-token');
  expect(first.token_iv).not.toBe(second.token_iv);
  expect(decryptMetaAdsToken(first)).toBe('synthetic-token');
 });
 it('rejects tampered credentials and missing encryption secrets', () => {
  process.env.NEXTAUTH_SECRET = 'test-only-nextauth-secret-with-sufficient-length';
  const encrypted = encryptMetaAdsToken('synthetic-token');
  expect(() => decryptMetaAdsToken({ ...encrypted, token_ciphertext: 'dGFtcGVyZWQ=' })).toThrow();
  delete process.env.NEXTAUTH_SECRET;
  expect(() => encryptMetaAdsToken('synthetic-token')).toThrow();
 });
});
