export class DatabaseReadTimeout extends Error {
 readonly code = 'DATABASE_UNAVAILABLE';
 constructor() { super('The database is not responding. Please retry shortly.'); }
}

/** Bound a read and cancel its transport. Parent cancellation stays distinct
 * from a timeout so an unmounted view does not display a failure. */
export async function requestDeadline<T>(read: (signal: AbortSignal) => PromiseLike<T>, milliseconds: number, parent?: AbortSignal): Promise<T> {
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
 const cancelled = new Promise<never>((_, reject) => {
  onAbort = () => { const reason = parent?.reason || new DOMException('Request cancelled', 'AbortError'); controller.abort(reason); reject(reason); };
  if (parent?.aborted) { onAbort(); return; }
  parent?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => { const error = new DatabaseReadTimeout(); controller.abort(error); reject(error); }, milliseconds);
 });
 try { return await Promise.race([cancelled, Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); })]); }
 finally { if (timer) clearTimeout(timer); if (onAbort) parent?.removeEventListener('abort', onAbort); }
}
