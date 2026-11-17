import { describe, expect, it } from 'vitest';
import { buildRoutePattern, createIssuesRouteTracker, type CapturedBreadcrumb } from '../../src/issues';

describe('issues route pattern', () => {
  it('replaces each param segment with its name', () => {
    expect(buildRoutePattern('/books/12/chapters/3', { bookId: '12', chapterId: '3' })).toBe('/books/[bookId]/chapters/[chapterId]');
  });

  it('matches equal values left to right', () => {
    expect(buildRoutePattern('/books/3/chapters/3', { bookId: '3', chapterId: '3' })).toBe('/books/[bookId]/chapters/[chapterId]');
    expect(buildRoutePattern('/en/books/en', { lang: 'en', slug: 'en' })).toBe('/[lang]/books/[slug]');
  });

  it('replaces a catch-all run and decodes encoded segments', () => {
    expect(buildRoutePattern('/docs/a/b/c', { path: ['a', 'b', 'c'] })).toBe('/docs/[...path]');
    expect(buildRoutePattern('/authors/J%C3%BCrgen', { name: 'Jürgen' })).toBe('/authors/[name]');
    expect(buildRoutePattern('/bad/%E0%A4%A', { value: '%E0%A4%A' })).toBe('/bad/[value]');
  });

  it('leaves unknown params, empty catch-alls and the root alone', () => {
    expect(buildRoutePattern('/books', { bookId: '9', rest: [], none: undefined })).toBe('/books');
    expect(buildRoutePattern('/', null)).toBe('/');
    expect(buildRoutePattern('', undefined)).toBe('/');
  });

  it('tracks routes: sets the route and adds a breadcrumb only when the pattern changes', () => {
    const routes: [string | null, string | null][] = [];
    const breadcrumbs: CapturedBreadcrumb[] = [];
    const routeTracker = createIssuesRouteTracker(
      { setRoute: (pattern, url) => routes.push([pattern, url]), addBreadcrumb: (breadcrumb) => breadcrumbs.push(breadcrumb) },
      () => '2026-01-01T00:00:00.000Z',
    );
    expect(routeTracker.trackRoute('/books/1', { bookId: '1' })).toBe('/books/[bookId]');
    routeTracker.trackRoute('/books/2', { bookId: '2' }, 'https://app.example.com/books/2');
    routeTracker.trackRoute('/authors', {});
    expect(routes).toEqual([
      ['/books/[bookId]', '/books/1'],
      ['/books/[bookId]', 'https://app.example.com/books/2'],
      ['/authors', '/authors'],
    ]);
    expect(breadcrumbs.map((breadcrumb) => breadcrumb.message)).toEqual(['(start) → /books/[bookId]', '/books/[bookId] → /authors']);
    expect(breadcrumbs[1]).toMatchObject({ category: 'navigation', from: '/books/[bookId]', to: '/authors' });
  });
});
