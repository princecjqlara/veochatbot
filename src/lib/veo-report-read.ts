import { DatabaseReadTimeout, requestDeadline } from './request-deadline';

/** Retry only transient read timeouts. Every attempt runs the SQL permission
 * checks again; invalid filters and authorization failures return immediately. */
export async function readVeoReport(read: (signal: AbortSignal) => PromiseLike<any>, milliseconds = 45000) {
    const deadline = Date.now() + milliseconds;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new DatabaseReadTimeout();
            const result = await requestDeadline(read, Math.min(18000, remaining));
            if (result?.error?.code === '57014') throw new DatabaseReadTimeout();
            return result;
        } catch (error) {
            if (!(error instanceof DatabaseReadTimeout) || attempt === 2 || deadline - Date.now() <= 1000) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }
    throw new DatabaseReadTimeout();
}
