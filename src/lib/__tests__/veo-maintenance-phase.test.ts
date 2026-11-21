import { afterEach, expect, it, vi } from 'vitest';
import { runMaintenancePhase } from '../veo-maintenance-phase';
afterEach(() => { vi.restoreAllMocks(); });

it('does no maintenance when another instance owns the phase or its cooldown is active', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: false }) }, operation = vi.fn();
    expect(await runMaintenancePhase(db, 'salary', operation)).toEqual({ skipped: true, reason: 'maintenance_not_due' });
    expect(operation).not.toHaveBeenCalled();expect(db.rpc).toHaveBeenCalledTimes(1);
});
it('fails closed when distributed coordination is unavailable', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ error: { code: '57014' } }) }, operation = vi.fn();
    await expect(runMaintenancePhase(db, 'salary', operation)).rejects.toThrow('scheduling');
    expect(operation).not.toHaveBeenCalled();
});
it('checkpoints success only for a successful operation and uses the same owner', async () => {
    for (const error of [null, { code: '55P03' }]) {
        const db = { rpc: vi.fn().mockResolvedValue({ data: true }) };
        const result = { error, data: { kept: true } };
        expect(await runMaintenancePhase(db, 'operations', async () => result)).toBe(result);
        expect(db.rpc).toHaveBeenLastCalledWith('veo_finish_maintenance_phase', {
            p_phase: 'operations', p_owner: db.rpc.mock.calls[0][1].p_owner, p_success: !error
        });
    }
});
it('records failures, preserves the original exception and tolerates an unavailable completion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = Error('maintenance failed');
    for (const finish of [{ data: false }, { error: { code: '57014' } }, Error('completion unavailable')]) {
        const db = { rpc: vi.fn().mockResolvedValueOnce({ data: true }) };
        if (finish instanceof Error) db.rpc.mockRejectedValueOnce(finish);else db.rpc.mockResolvedValueOnce(finish);
        await expect(runMaintenancePhase(db, 'salary', async () => { throw error; })).rejects.toBe(error);
        expect(db.rpc.mock.calls[1][1].p_success).toBe(false);
    }
});
