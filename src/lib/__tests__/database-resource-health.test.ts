import { expect, it } from 'vitest';
import { parseDatabaseResourceMetrics } from '../database-resource-health';
const metrics = `node_memory_MemTotal_bytes 4e8
node_memory_MemAvailable_bytes 9e7
node_memory_SwapTotal_bytes 1e9
node_memory_SwapFree_bytes 5e8
node_load5 1.8
node_cpu_seconds_total{cpu="0",mode="idle"} 100
node_cpu_seconds_total{cpu="0",mode="user"} 40
node_cpu_seconds_total{cpu="1",mode="idle"} 101`;
it('counts CPUs once and uses available memory instead of free memory', () => {
    expect(parseDatabaseResourceMetrics(metrics + '\nnode_memory_MemFree_bytes 100')).toEqual({ resource_metrics_available: true,
        memory_total_bytes: 400000000, memory_available_bytes: 90000000, swap_total_bytes: 1000000000, swap_free_bytes: 500000000, cpu_count: 2, load_5m: 1.8 });
});
it('rejects missing, impossible and ambiguous samples instead of reporting healthy resources', () => {
    expect(parseDatabaseResourceMetrics('')).toEqual({ resource_metrics_available: false });
    expect(parseDatabaseResourceMetrics(metrics.replace('9e7', '9e9'))).toEqual({ resource_metrics_available: false });
    expect(parseDatabaseResourceMetrics(metrics.replace('5e8', '5e9'))).toEqual({ resource_metrics_available: false });
    expect(() => parseDatabaseResourceMetrics(metrics + '\nnode_load5 0')).toThrow('Ambiguous');
});
it('reports a new load spike and the exporter sample time independently of the five-minute average', () => {
    const result=parseDatabaseResourceMetrics(metrics+'\nnode_load1{service_type="db"} 5.16\nnode_time_seconds{service_type="db"} 1795084808.75');
    expect(result).toMatchObject({resource_metrics_available:true,load_1m:5.16,load_5m:1.8,resource_sample_epoch:1795084808.75});
    expect(()=>parseDatabaseResourceMetrics(metrics+'\nnode_load1 1\nnode_load1 2')).toThrow('Ambiguous');
});
