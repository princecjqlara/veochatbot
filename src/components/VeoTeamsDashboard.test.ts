import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ href, children }: any) => createElement('a', { href }, children) }));
import VeoTeamsDashboard from './VeoTeamsDashboard';
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : node.children.map(text).join('');
it('shows a team with only a team leader even when its capacity is zero and no manager exists', async () => {
    const data = {
        accounts: [{ id: 'leader', role: 'team_leader', name: 'Team Leader', active: true }],
        teams: [{ id: 'team', name: 'Leader Team', manager_id: 'leader' }],
        capacity: { teams: [{ id: 'team', workers: 0, closed: 0, done: 0, capacity: 0, quota: { closed: 0, done: 0 }, history: {}, tomorrow: {} }] }, salary: [], tomorrow: []
    };
    let view: any; await act(async () => { view = create(createElement(VeoTeamsDashboard, { data })); });
    try {
        expect(view.root.findAllByType('article')).toHaveLength(1);
        expect(text(view.root)).toContain('Team leader: Team Leader');
        expect(text(view.root)).toContain('This team is ready with its team leader');
        expect(text(view.root)).not.toContain('No teams in this branch yet');
        await act(async () => view.root.findByType('select').props.onChange({ target: { value: 'leader' } }));
        expect(view.root.findAllByType('article')).toHaveLength(1);
    } finally { await act(async () => view.unmount()); }
});
it('keeps team totals and currencies separate and reads attendance from the Telegram poll', async () => {
    const attendance = vi.fn();
    const data = {
        accounts: [
            { id: 'la', role: 'team_leader', name: 'Leader A' }, { id: 'lb', role: 'team_leader', name: 'Leader B' },
            { id: 'ma', role: 'manager', name: 'Manager A', parent_id: 'la' }, { id: 'wa', role: 'member', name: 'Member A', parent_id: 'ma' },
            { id: 'mb', role: 'manager', name: 'Manager B', parent_id: 'lb' }
        ],
        teams: [{ id: 'ta', name: 'Team A', manager_id: 'ma' }, { id: 'tb', name: 'Team B', manager_id: 'mb' }],
        salary: [
            { user_id: 'ma', closed: 2, done: 1, target: 1, rate: 40, totals: [{ currency: 'PHP', commission_minor: 1000 }, { currency: 'USD', commission_minor: 200 }] },
            { user_id: 'wa', closed: 1, done: 2, target: 1, rate: 40, totals: [{ currency: 'PHP', commission_minor: 2000 }] },
            { user_id: 'mb', closed: 9, done: 9, target: 1, rate: 40, totals: [{ currency: 'PHP', commission_minor: 9000 }] }
        ],
        tomorrow: [{ user_id: 'ma', active: true, target: 2 }, { user_id: 'wa', active: false, target: 2 }, { user_id: 'mb', active: true, target: 3 }]
    };
    let view: any; await act(async () => { view = create(createElement(VeoTeamsDashboard, { data, busy: false, onAttendance: attendance })); });
    try {
        const first = view.root.findAllByType('article')[0];
        expect(text(first)).toContain('team target 2'); expect(text(first)).toContain('1 active');
        expect(text(first)).toContain(new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(30));
        expect(text(first)).toContain(new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'USD' }).format(2));
        await act(async () => view.root.findAllByType('select').find((s: any) => s.props.value === '')!.props.onChange({ target: { value: 'la' } }));
        expect(view.root.findAllByType('article')).toHaveLength(1); expect(text(view.root)).not.toContain('Team BManager');
        expect(view.root.findAllByType('select').some((s: any) => s.props['aria-label'] === 'Attendance for Member A')).toBe(false);
        expect(text(first)).toContain('Telegram poll'); expect(attendance).not.toHaveBeenCalled();
    } finally { await act(async () => view.unmount()); }
});
