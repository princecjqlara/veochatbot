// Only explicitly identified report reads may outlive the default transport
// timeout. Supabase sends RPC reads as POST, just like assignment mutations.
const deadlines = new WeakMap<AbortSignal, number>();
export function setSupabaseReadBudget(signal: AbortSignal, milliseconds: number) {
    deadlines.set(signal, Date.now() + milliseconds);
}
export function supabaseReadBudget(signal?: AbortSignal) {
    const deadline = signal && deadlines.get(signal);
    return deadline ? Math.max(1, deadline - Date.now()) : undefined;
}
