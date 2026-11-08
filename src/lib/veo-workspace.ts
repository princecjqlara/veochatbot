import { createHash, randomUUID } from 'node:crypto';
import { hash, compare } from 'bcryptjs';
import { getSupabaseAdmin } from './supabase';
import { readVeoRpc } from './veo-report-read';

export const workspaceEnabled = () => process.env.VEO_WORKSPACE_ENABLED === 'true';
export const roles = ['member', 'manager', 'team_leader', 'owner'] as const;
export type WorkspaceRole = typeof roles[number];
export type WorkspaceScope = { user_id: string; tenant_id: string; role: WorkspaceRole; page_ids: string[]; worker_ids: string[]; launch_at: string | null; telegram_username?: string | null; telegram_profile_completed_at?: string | null };
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Prehash avoids bcrypt's 72-byte truncation while accepting every nonempty password.
const passwordInput = (password: string) => createHash('sha256').update(password, 'utf8').digest('base64');
export async function passwordHash(password: string) {
    if (typeof password !== 'string' || password.length === 0) throw new Error('Enter a password');
    return 'veo-sha256:' + await hash(passwordInput(password), 12);
}
export async function passwordMatches(password: string, stored: string) {
    if (!password || !stored?.startsWith('veo-sha256:')) return false;
    return compare(passwordInput(password), stored.slice(11));
}
export async function workspaceScope(userId: string): Promise<WorkspaceScope | null> {
    const { data, error } = await readVeoRpc(getSupabaseAdmin(), 'veo_scope', { p_actor: userId }, 20000);
    if (error) throw Object.assign(new Error('Workspace permissions are temporarily unavailable. Retry shortly.'), { status: 503 });
    return data;
}
export async function workspaceAction(actor: string, action: string, payload: Record<string, unknown>) {
    const { data, error } = await getSupabaseAdmin().rpc('veo_action', { p_actor: actor, p_action: action, p_data: payload });
    if (error) throw Object.assign(new Error(error.code === '57014' ? 'The save timed out. Recheck the saved record before trying again.' : error.message), { status: error.code === '42501' ? 403 : error.code === '23505' ? 409 : error.code === '57014' ? 503 : 400 });
    return data;
}
export async function createWorkspaceAccount(actor: string, body: any) {
    if (!roles.includes(body.role) || typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
        !uuid(body.parent_id) || !Array.isArray(body.page_ids) || (!body.page_ids.length && body.role !== 'member') || !body.page_ids.every(uuid) ||
        typeof body.name !== 'string' || !body.name.trim()) throw new Error('Name, email, role, supervisor and pages are required');
    return workspaceAction(actor, 'create_account', { ...body, user_id: randomUUID(), email: body.email.trim().toLowerCase(), password_hash: await passwordHash(body.password), password: undefined });
}
export const philippineDate = (date = new Date()) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
