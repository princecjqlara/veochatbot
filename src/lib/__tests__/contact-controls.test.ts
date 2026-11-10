import { expect, it, vi } from 'vitest';
import { contactControls } from '../contact-controls';
it('reads controls for every requested contact with two bounded workers and one Page lookup', async () => {
    const ids = Array.from({ length: 231 }, (_, i) => String(i));let active = 0, peak = 0;
    const page = vi.fn(async () => ({ data: { name: 'Page', fb_page_id: 'fb-page' } }));const q: any = { select: () => q, eq: () => q, maybeSingle: page };
    const rpc = vi.fn(async (_name, args) => { active++;peak = Math.max(peak, active);await Promise.resolve();active--;return { data: args.p_contact_ids.map((id: string) => ({ contact_id: id, enabled: true, reason: 'allowed' })) }; });
    const loaded = await contactControls({ from: () => q, rpc }, 'page', ids);
    expect(loaded.size).toBe(231);expect(loaded.has('230')).toBe(true);expect(rpc).toHaveBeenCalledTimes(3);expect(peak).toBeLessThanOrEqual(2);expect(page).toHaveBeenCalledOnce();
});
it('rejects a missing or unavailable control slice rather than supplying a partial success', async () => {
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: {} }) };
    await expect(contactControls({ from: () => q, rpc: async () => ({ data: [] }) }, 'page', ['id'])).rejects.toThrow('Complete contact controls');
    await expect(contactControls({ from: () => q, rpc: async () => ({ error: { message: 'offline' } }) }, 'page', ['id'])).rejects.toThrow('Contact controls');
});
