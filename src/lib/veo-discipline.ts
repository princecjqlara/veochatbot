import { uuid } from './veo-workspace';

export function disciplinePayload(body: any) {
    if (!body || typeof body !== 'object' || !['policy', 'issue', 'remove', 'suspend', 'lift'].includes(body.action)) throw Error('Choose a warning or suspension action');
    const duration = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 525600;
    if (body.action === 'policy') {
        if (!Number.isSafeInteger(body.warning_limit) || body.warning_limit < 1 || body.warning_limit > 100 || typeof body.auto_suspend !== 'boolean' || !duration(body.suspension_minutes)) throw Error('Set a warning limit from 1 to 100 and a valid suspension duration');
        return { warning_limit: body.warning_limit, auto_suspend: body.auto_suspend, suspension_minutes: body.suspension_minutes };
    }
    if (!uuid(body.user_id) || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 500) throw Error('Choose a member and enter a reason of 3 to 500 characters');
    const data: Record<string, unknown> = { user_id: body.user_id, reason: body.reason.trim() };
    if (['issue', 'suspend'].includes(body.action)) {
        if (!uuid(body.request_id)) throw Error('A valid request reference is required');
        data.request_id = body.request_id;
    }
    if (body.action === 'suspend') {
        if (!duration(body.duration_minutes)) throw Error('Choose a timed suspension or manual lifting');
        data.duration_minutes = body.duration_minutes;
    }
    if (body.action === 'lift') {
        if (!uuid(body.suspension_id)) throw Error('Choose the current suspension');
        data.suspension_id = body.suspension_id;
    }
    if (body.action === 'remove') {
        if (typeof body.source_key !== 'string' || !body.source_key || body.source_key.length > 300) throw Error('Choose a warning');
        data.source_key = body.source_key;
    }
    return data;
}
