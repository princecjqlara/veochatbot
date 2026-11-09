import { expect, it, vi } from 'vitest';
import { runBackgroundJob } from '../background-run';
it('coalesces overlapping cron work and permits the next run after completion or failure', async () => {
    let finish!: (value: string) => void;
    const running = runBackgroundJob('test', () => new Promise<string>(resolve => { finish = resolve; }));
    expect(await runBackgroundJob('test', async () => 'duplicate')).toEqual({ skipped: true, reason: 'already_running' });
    expect(await runBackgroundJob('other', async () => 'independent')).toBe('independent');
    finish('done'); expect(await running).toBe('done');
    await expect(runBackgroundJob('test', async () => { throw Error('failed'); })).rejects.toThrow('failed');
    expect(await runBackgroundJob('test', async () => 'retry')).toBe('retry');
});
it('skips another serverless owner and releases only its own lease after failures', async () => {
    const db = { rpc: vi.fn(async (_name: string, _args: any) => ({ data: false, error: null })) }, operation = vi.fn(async () => 'done');
    expect(await runBackgroundJob('distributed', operation, db)).toEqual({ skipped: true, reason: 'already_running' });
    expect(operation).not.toHaveBeenCalled();
    db.rpc.mockResolvedValue({ data: true, error: null });
    await expect(runBackgroundJob('distributed', async () => { throw Error('worker failed'); }, db)).rejects.toThrow('worker failed');
    const claim = db.rpc.mock.calls.filter(c => c[0] === 'veo_claim_background_job').at(-1)!;
    expect(db.rpc).toHaveBeenCalledWith('veo_release_background_job', { p_job: 'distributed', p_owner: claim[1].p_owner });
});
