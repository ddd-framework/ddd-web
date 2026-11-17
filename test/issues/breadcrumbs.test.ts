import { describe, expect, it } from 'vitest';
import {
  consoleBreadcrumb,
  createBreadcrumbTrail,
  customBreadcrumb,
  fetchBreadcrumb,
  navigationBreadcrumb,
  uiBreadcrumb,
} from '../../src/issues';

const at = '2026-01-01T00:00:00.000Z';

describe('issues breadcrumbs', () => {
  it('builds redacted, capped breadcrumbs', () => {
    expect(fetchBreadcrumb(at, 'post', 'https://api.example.com/invitations/abc?token=1', 500)).toEqual({
      at,
      category: 'fetch',
      message: 'POST 500',
      url: 'https://api.example.com/invitations/[redacted]?token=[redacted]',
      from: null,
      to: null,
      status: 500,
    });
    expect(fetchBreadcrumb(at, 'GET', '/x', 'network-error')).toMatchObject({ message: 'GET network-error', status: null });
    expect(consoleBreadcrumb(at, 'failed for ana@example.com').message).toBe('failed for [email]');
    expect(consoleBreadcrumb(at, 'x'.repeat(400)).message).toHaveLength(256);
    expect(uiBreadcrumb(at, 'save-book')).toMatchObject({ category: 'ui', message: 'save-book' });
    expect(navigationBreadcrumb(at, null, '/books')).toMatchObject({ message: '(start) → /books', from: null, to: '/books' });
    expect(customBreadcrumb(at, 'cart', { status: 1 })).toMatchObject({ category: 'custom', status: 1 });
  });

  it('keeps the newest breadcrumbs, oldest first', () => {
    const trail = createBreadcrumbTrail(3);
    for (let index = 1; index <= 5; index++) trail.add(uiBreadcrumb(at, `click-${index}`));
    expect(trail.snapshot().map((breadcrumb) => breadcrumb.message)).toEqual(['click-3', 'click-4', 'click-5']);
    trail.snapshot().pop();
    expect(trail.snapshot()).toHaveLength(3);
  });
});
