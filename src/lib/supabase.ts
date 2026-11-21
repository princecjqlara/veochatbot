import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {assertVeoDatabaseUrl} from './veo-database-scope';
import { supabaseFetch } from './supabase-fetch';
import { createSupabaseAvailabilityGate } from './supabase-availability';

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

let supabaseBrowserClient: GenericSupabaseClient | null = null;
let supabaseAdminClient: GenericSupabaseClient | null = null;
let supabaseAccessClient: GenericSupabaseClient | null = null;
let supabaseInteractiveClient: GenericSupabaseClient | null = null;
// A server request makes one attempt. Retrying at every layer multiplies load
// during an outage; the gate allows one recovery probe after a short cooldown.
const adminFetch = createSupabaseAvailabilityGate((input, init) => supabaseFetch(input, init, 1));
// A failed report or background batch must not open the sign-in/permission
// circuit. Access still checks the live database and has its own outage gate.
const accessFetch = createSupabaseAvailabilityGate((input, init) => supabaseFetch(input, init, 1));
// Basic directory and contact reads must not inherit a heavy report/cron
// timeout. This still checks the live database and gates its own real outages.
const interactiveFetch = createSupabaseAvailabilityGate((input, init) => supabaseFetch(input, init, 1));

export function getSupabaseClient(): GenericSupabaseClient {
    if (!supabaseBrowserClient) {
        supabaseBrowserClient = createClient(getSupabaseUrl(), getSupabaseAnonKey(), { global: { fetch: supabaseFetch } });
    }
    return supabaseBrowserClient;
}

export function getSupabaseAdmin(signal?: AbortSignal, purpose: 'default' | 'access' | 'interactive' = 'default'): GenericSupabaseClient {
    const existing = purpose === 'access' ? supabaseAccessClient : purpose === 'interactive' ? supabaseInteractiveClient : supabaseAdminClient;
    if (existing && !signal) return existing;
    const fetcher = purpose === 'access' ? accessFetch : purpose === 'interactive' ? interactiveFetch : adminFetch;
    const client = createClient(getSupabaseUrl(), getSupabaseServiceKey(), {
        global: { fetch: signal ? (input, init) => fetcher(input, {
            ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal
        }) : fetcher },
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    });
    if (signal) return client;
    if (purpose === 'access') supabaseAccessClient = client;
    else if (purpose === 'interactive') supabaseInteractiveClient = client;
    else supabaseAdminClient = client;
    return client;
}
