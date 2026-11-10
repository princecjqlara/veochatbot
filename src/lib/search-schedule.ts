/** Start initial loads and deliberate filter/refresh actions immediately.
 * Only changed search text waits for typing to settle. Use inside the effect. */
export function createSearchSchedule(initial: string, debounceMs = 250) {
    let previous = initial;
    return (search: string) => {
        const delay = search === previous ? 0 : debounceMs;
        previous = search;
        return delay;
    };
}
