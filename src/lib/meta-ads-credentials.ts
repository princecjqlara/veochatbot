import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

type Ciphertext = { token_ciphertext: string; token_iv: string; token_auth_tag: string };
function key() {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret || secret.length < 32) throw new Error('NEXTAUTH_SECRET must be configured to retain encrypted Meta Ads access');
    return createHash('sha256').update('veobot-meta-ads-credential:v1:').update(secret).digest();
}
export function encryptMetaAdsToken(token: string): Ciphertext {
    if (!token || token.length > 8192) throw new Error('Invalid Meta Ads access token');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return { token_ciphertext: ciphertext.toString('base64'), token_iv: iv.toString('base64'), token_auth_tag: cipher.getAuthTag().toString('base64') };
}
export function decryptMetaAdsToken(value: Ciphertext): string {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(value.token_iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.token_auth_tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.token_ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
