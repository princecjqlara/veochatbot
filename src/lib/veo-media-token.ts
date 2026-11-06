import { createHmac, timingSafeEqual } from 'node:crypto';
export function mediaToken(assetId: string, expires: number) {
    if (!process.env.NEXTAUTH_SECRET) throw new Error('Media signing is unavailable');
    return createHmac('sha256', process.env.NEXTAUTH_SECRET).update(`veo-media:${assetId}:${expires}`).digest('hex');
}
export function validMediaToken(assetId: string, expires: string | null, token: string | null) {
    const time = Number(expires), now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(time) || time <= now || time > now + 3600 || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(mediaToken(assetId, time)));
}
