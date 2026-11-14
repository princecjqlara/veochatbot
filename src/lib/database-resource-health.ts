/** Read host pressure, not MemFree (which excludes reusable filesystem cache). */
export function parseDatabaseResourceMetrics(source: string) {
    const values = new Map<string, number>(), cpus = new Set<string>();
    for (const line of source.split('\n')) {
        const sample = /^(node_memory_(?:MemTotal|MemAvailable|SwapTotal|SwapFree)_bytes|node_load5|node_cpu_seconds_total)(?:\{([^}]*)\})?\s+([\d.eE+-]+)(?:\s|$)/.exec(line);
        if (!sample) continue;
        const value = Number(sample[3]);
        if (!Number.isFinite(value) || value < 0) continue;
        if (sample[1] === 'node_cpu_seconds_total') {
            if (/(?:^|,)mode="idle"(?:,|$)/.test(sample[2] || '')) {
                const cpu = /(?:^|,)cpu="(\d+)"(?:,|$)/.exec(sample[2] || '');
                if (cpu) cpus.add(cpu[1]);
            }
        } else {
            if (values.has(sample[1])) throw Error('Ambiguous database resource metrics');
            values.set(sample[1], value);
        }
    }
    const total = values.get('node_memory_MemTotal_bytes'), available = values.get('node_memory_MemAvailable_bytes');
    const swapTotal = values.get('node_memory_SwapTotal_bytes'), swapFree = values.get('node_memory_SwapFree_bytes'), load = values.get('node_load5');
    if (!total || available == null || available > total || swapTotal == null || swapFree == null || swapFree > swapTotal || load == null || !cpus.size) return { resource_metrics_available: false as const };
    return { resource_metrics_available: true as const, memory_total_bytes: Math.round(total), memory_available_bytes: Math.round(available),
        swap_total_bytes: Math.round(swapTotal), swap_free_bytes: Math.round(swapFree), cpu_count: cpus.size, load_5m: load };
}
