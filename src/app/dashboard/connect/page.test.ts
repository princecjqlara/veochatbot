import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('@/components/VeoPageConnections', () => ({ default: () => createElement('p', null, 'Pages & connections') }));
import Page from './page';
it('opens Page management on the original connection URL', async () => {
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(createElement(Page)); });
    expect(JSON.stringify(view.toJSON())).toContain('Pages & connections');
    await act(async () => view.unmount());
});
