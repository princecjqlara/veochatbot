import { expect, it } from 'vitest';
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
