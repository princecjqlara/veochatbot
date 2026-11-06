import { AsyncLocalStorage } from 'node:async_hooks';
export const veoEventReplay = new AsyncLocalStorage<boolean>();
