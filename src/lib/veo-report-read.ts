import { DatabaseReadTimeout, requestDeadline } from './request-deadline';
import { isSupabaseTimeoutOrOverload, isSupabaseUnavailable } from './supabase-errors';
import { setSupabaseReadBudget } from './supabase-read-budget';

/** Retry only transient read timeouts. Every attempt runs the SQL permission
 * checks again; invalid filters and authorization failures return immediately. */
export async function readVeoReport(read: (signal: AbortSignal) => PromiseLike<any>, milliseconds = 45000) {
    const deadline = Date.now() + milliseconds;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new DatabaseReadTimeout();
            const budget = Math.min(18000, remaining);
            const result = await requestDeadline(signal => {
                setSupabaseReadBudget(signal, budget);
                return read(signal);
            }, budget);
            // The SDK resolves transport failures as { error }, including
            // errors whose timeout code was replaced with an empty string.
            // A pre-existing open circuit still fails fast; do not probe it
            // again for every incoming workspace request.
            if (result?.error?.code !== 'SUPABASE_CIRCUIT_OPEN' && isSupabaseUnavailable(result?.error)) throw result.error;
            return result;
        } catch (error) {
            if (!isSupabaseUnavailable(error)) throw error;
            if (isSupabaseTimeoutOrOverload(error)) throw new DatabaseReadTimeout();
            const delay = 2000;
            if (attempt === 1 || deadline - Date.now() <= delay + 1000) throw new DatabaseReadTimeout();
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new DatabaseReadTimeout();
}

export const readVeoRpc = (db: any, name: string, args: Record<string, unknown>, milliseconds?: number) => readVeoReport(signal => {
    const query = db.rpc(name, args);
    return typeof query?.abortSignal === 'function' ? query.abortSignal(signal) : query;
}, milliseconds);
