import { describe, expect, it } from 'vitest';
import {
  buildTranslationKey,
  FILTER_OPERATORS,
  formatDddDate,
  formatDddDateTime,
  getContractInfo,
  hasSideEffects,
  isFilterOperator,
  isHiddenProperty,
  isListOperator,
  isPreservedOnOmission,
  isTranslatableProperty,
  isValidDddDate,
  normalizeTranslationInfos,
  normalizeTranslationsStore,
  parseDddDateTime,
  parseDddDateTimeMs,
  parseEntityIdentity,
  parseTranslationKey,
  type DddOperationExtensions,
  type DddPropertyExtensions,
  type DddQueryDefinition,
} from '../../src/contract';

describe('operators', () => {
  it('lists every backend operator incl. ni', () => {
    expect(FILTER_OPERATORS).toEqual(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'ni', 'bw', 'ft', 'fb']);
    expect(isFilterOperator('ni')).toBe(true);
    expect(isFilterOperator('like')).toBe(false);
    expect(isListOperator('ni')).toBe(true);
    expect(isListOperator('eq')).toBe(false);
  });
});

describe('x-ddd-* helpers', () => {
  it('applies the side-effect defaults (A.6) and explicit overrides', () => {
    expect(hasSideEffects('GET')).toBe(false);
    expect(hasSideEffects('head', {})).toBe(false);
    expect(hasSideEffects('post')).toBe(true);
    expect(hasSideEffects('PATCH', null)).toBe(true);
    expect(hasSideEffects('delete')).toBe(true);
    expect(hasSideEffects('get', { 'x-ddd-side-effects': true })).toBe(true);
    expect(hasSideEffects('post', { 'x-ddd-side-effects': false })).toBe(false);
  });

  it('reads field-level extensions with absent = default', () => {
    const hidden: DddPropertyExtensions = { 'x-ddd-hidden': true };
    expect(isHiddenProperty(hidden)).toBe(true);
    expect(isHiddenProperty({})).toBe(false);
    expect(isPreservedOnOmission({ 'x-ddd-preserve-on-omission': true })).toBe(true);
    expect(isPreservedOnOmission(undefined)).toBe(false);
    expect(isTranslatableProperty({ 'x-ddd-translatable': { fullTextIndex: false } })).toBe(true);
    expect(isTranslatableProperty({})).toBe(false);
  });

  it('parses entity identities and the contract version', () => {
    expect(parseEntityIdentity('body:book.id')).toEqual({ source: 'body', name: 'book.id' });
    expect(parseEntityIdentity('path:bookId')).toEqual({ source: 'path', name: 'bookId' });
    expect(parseEntityIdentity('bookId')).toBeNull();
    expect(parseEntityIdentity(undefined)).toBeNull();
    expect(getContractInfo({ info: { 'x-ddd-contract': { contract: 1, ddd: '3.14.0' } } })).toEqual({
      contract: 1,
      ddd: '3.14.0',
    });
    expect(getContractInfo({ info: {} })).toBeNull();
    expect(getContractInfo(null)).toBeNull();
  });

  it('types the wire example of an operation', () => {
    const query: DddQueryDefinition = {
      filters: [
        {
          name: 'title',
          path: 'title',
          columnKind: 'translatable',
          supportsFulltext: false,
          operators: ['eq', 'ne'],
          valueRules: { eq: 'wildcard-required' },
        },
        {
          name: 'created',
          path: 'changeHistory.createdTime',
          columnKind: 'datetime',
          temporalKind: 'MOMENT',
          operators: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'bw'],
        },
      ],
      orderBy: ['title', 'id', 'created'],
      expand: [{ name: 'coverSvg', computed: true }, { name: 'author', expand: [{ name: 'books' }] }],
      select: true,
      top: 50,
      maxTop: 1000,
    };
    const operation: DddOperationExtensions = {
      'x-ddd-query': query,
      'x-ddd-entity': { schema: 'App.Domain.Library.Entities.Books.Book', action: 'list', derived: true },
    };
    expect(operation['x-ddd-query']?.maxTop).toBe(1000);
  });
});

describe('translations', () => {
  it('normalises the empty wire store [] to {}', () => {
    expect(normalizeTranslationsStore([])).toEqual({});
    expect(normalizeTranslationsStore(null)).toEqual({});
    expect(normalizeTranslationsStore(undefined)).toEqual({});
  });

  it('keeps a filled store and normalises empty property entries', () => {
    expect(
      normalizeTranslationsStore({
        title: { 'en::FORMAL': 'The Book', 'de::FORMAL': 'Das Buch', 'fr::FORMAL': 7 },
        subtitle: [],
      }),
    ).toEqual({ title: { 'en::FORMAL': 'The Book', 'de::FORMAL': 'Das Buch' }, subtitle: {} });
  });

  it('normalises TranslationInfos', () => {
    const infos = normalizeTranslationInfos({
      translationsStore: [],
      availableTranslations: [],
      replaceExistingTranslations: false,
      currentLanguageCode: 'en',
    });
    expect(infos.translationsStore).toEqual({});
    expect(infos.availableTranslations).toEqual({});
    expect(infos.currentLanguageCode).toBe('en');
    expect(normalizeTranslationInfos({ availableTranslations: { en: true } }).availableTranslations).toEqual({ en: true });
  });

  it('builds and parses translation keys like the backend', () => {
    expect(buildTranslationKey({ languageCode: 'EN', writingStyle: 'FORMAL' })).toBe('en::FORMAL');
    expect(buildTranslationKey({ languageCode: 'de', countryCode: 'AT', writingStyle: 'INFORMAL' })).toBe(
      'de:at:INFORMAL',
    );
    expect(parseTranslationKey('de:at:INFORMAL')).toEqual({
      languageCode: 'de',
      countryCode: 'at',
      writingStyle: 'INFORMAL',
    });
    expect(parseTranslationKey('en::FORMAL')).toEqual({ languageCode: 'en', countryCode: null, writingStyle: 'FORMAL' });
    expect(parseTranslationKey('en')).toBeNull();
  });
});

describe('DDD date-times', () => {
  it('reads offset-less values as UTC', () => {
    expect(parseDddDateTimeMs('2026-01-02 03:04:05')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parseDddDateTimeMs('2026-01-02T03:04:05')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parseDddDateTimeMs('2026-01-02 03:04:05.250')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 250));
    expect(parseDddDateTimeMs('2026-01-02 03:04')).toBe(Date.UTC(2026, 0, 2, 3, 4));
    expect(parseDddDateTimeMs('2026-01-02')).toBe(Date.UTC(2026, 0, 2));
  });

  it('parses values with an offset or Z as given', () => {
    expect(parseDddDateTimeMs('2026-01-02T03:04:05Z')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parseDddDateTimeMs('2026-01-02T05:04:05+02:00')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parseDddDateTimeMs('2026-01-02 05:04:05+02:00')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
  });

  it('rejects absent and invalid values', () => {
    expect(parseDddDateTimeMs(null)).toBeNull();
    expect(parseDddDateTimeMs('')).toBeNull();
    expect(parseDddDateTimeMs('2026-13-45 00:00:00')).toBeNull();
    expect(parseDddDateTimeMs('2026-02-30')).toBeNull();
    expect(parseDddDateTimeMs('2026-01-02 24:00:00')).toBeNull();
    expect(parseDddDateTimeMs('yesterday')).toBeNull();
    expect(parseDddDateTime('nope')).toBeNull();
  });

  it('round-trips format and parse', () => {
    const value = '2026-10-31 23:59:58';
    const parsed = parseDddDateTime(value);
    expect(parsed?.toISOString()).toBe('2026-10-31T23:59:58.000Z');
    expect(formatDddDateTime(parsed as Date)).toBe(value);
    expect(formatDddDateTime(Date.UTC(2026, 0, 2, 3, 4, 5, 999))).toBe('2026-01-02 03:04:05');
    expect(formatDddDate(new Date(Date.UTC(2026, 0, 2, 23)))).toBe('2026-01-02');
    expect(() => formatDddDateTime(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('validates calendar dates', () => {
    expect(isValidDddDate('2024-02-29')).toBe(true);
    expect(isValidDddDate('2025-02-29')).toBe(false);
    expect(isValidDddDate('2026-13-45')).toBe(false);
    expect(isValidDddDate('2026-1-5')).toBe(false);
  });
});
