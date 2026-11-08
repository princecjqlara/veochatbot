import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {assertVeoDatabaseUrl} from './veo-database-scope';

function getSupabaseUrl() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    if (!url) {
        throw new Error('Missing Supabase URL. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL for server-only usage).');
    }
    assertVeoDatabaseUrl(url);
    return url;
}

function getSupabaseAnonKey() {
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!key) {
        throw new Error('Missing Supabase anon key. Set NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY for server-only usage).');
    }
    return key;
}

function getSupabaseServiceKey() {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
        throw new Error('Missing Supabase service role key. Set SUPABASE_SERVICE_ROLE_KEY.');
    }
    return key;
}

type GenericSupabaseClient = SupabaseClient<any, 'public', any>;

const retryableStatuses = new Set([502, 503, 504, 522, 524]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Retry only idempotent reads. A timed-out write may already have reached Postgres. */
async function supabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const canRetry = method === 'GET' || method === 'HEAD';
    let response: Response | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < (canRetry ? 3 : 1); attempt++) {
        if (attempt) await sleep(attempt * 250);
        try {
            response = await globalThis.fetch(input, init);
            if (!canRetry || !retryableStatuses.has(response.status) || attempt === 2) break;
        } catch (error) {
            lastError = error;
            response = undefined;
            if (!canRetry || attempt === 2) throw error;
        }
    }

    if (!response) throw lastError;
    const isCloudflareTimeout = response.status >= 520 && response.status <= 524;
    const isHtmlServerError = response.status >= 500 && response.headers.get('content-type')?.includes('text/html');
    if (!isCloudflareTimeout && !isHtmlServerError) return response;

    const ray = response.headers.get('cf-ray');
    return new Response(JSON.stringify({
        message: `Supabase API temporarily unavailable (HTTP ${response.status})`,
        code: `SUPABASE_UPSTREAM_${response.status}`
    }), {
        status: response.status,
        headers: {
            'content-type': 'application/json',
            ...(ray ? { 'x-supabase-upstream-ray': ray } : {})
        }
    });
}

let supabaseBrowserClient: GenericSupabaseClient | null = null;
let supabaseAdminClient: GenericSupabaseClient | null = null;

export function getSupabaseClient(): GenericSupabaseClient {
    if (!supabaseBrowserClient) {
        supabaseBrowserClient = createClient(getSupabaseUrl(), getSupabaseAnonKey(), { global: { fetch: supabaseFetch } });
    }
    return supabaseBrowserClient;
}

export function getSupabaseAdmin(): GenericSupabaseClient {
    if (!supabaseAdminClient) {
        supabaseAdminClient = createClient(getSupabaseUrl(), getSupabaseServiceKey(), {
            global: { fetch: supabaseFetch },
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
    }
    return supabaseAdminClient;
}
