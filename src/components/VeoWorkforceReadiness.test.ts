import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import Readiness from './VeoWorkforceReadiness';
it('explains disabled and unavailable staff evidence beside retained capacity without presenting a measured default', () => {
    const html = renderToStaticMarkup(createElement(Readiness, { readiness: { workers: 6, enabled: 1, disabled: 4, unknown: 1 } }));
    expect(html).toContain('1 of 6 roster accounts');expect(html).toContain('4 have disabled logins');expect(html).toContain('1 login states are unavailable');expect(html).toContain('target of one can be the default');expect(html).toContain('view=accounts');
    expect(renderToStaticMarkup(createElement(Readiness, { readiness: { workers: 1, enabled: 1, disabled: 0, unknown: 0 } }))).toBe('');
});
