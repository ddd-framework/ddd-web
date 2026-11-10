import { describe, expect, it } from 'vitest';
import { buildDddFormData, buildDddMultipartBody, hasDddMultipartFiles, mergeDddTagTypes } from '../../src/api';

describe('multipart bodies', () => {
  const file = new File(['abc'], 'note.txt', { type: 'text/plain' });

  it('detects file parts', () => {
    expect(hasDddMultipartFiles(undefined)).toBe(false);
    expect(hasDddMultipartFiles({ files: [] })).toBe(false);
    expect(hasDddMultipartFiles({ files: null })).toBe(false);
    expect(hasDddMultipartFiles({ files: file })).toBe(true);
  });

  it('keeps the JSON body while no file is given', () => {
    const body = { message: { text: 'hi' } };
    expect(buildDddMultipartBody(body, undefined)).toBe(body);
    expect(buildDddMultipartBody(body, { attachmentFiles: [] })).toBe(body);
  });

  it('builds the form: JSON envelope in `body`, files as `<field>[]`', async () => {
    const result = buildDddMultipartBody({ message: { text: 'hi' } }, { attachmentFiles: [file, new Blob(['x'])], cover: file });
    expect(result).toBeInstanceOf(FormData);
    const form = result as FormData;
    expect(JSON.parse(form.get('body') as string)).toEqual({ message: { text: 'hi' } });
    const parts = form.getAll('attachmentFiles[]') as File[];
    expect(parts.map((part) => part.name)).toEqual(['note.txt', 'attachmentFiles']);
    expect(await parts[0]!.text()).toBe('abc');
    expect((form.get('cover[]') as File).name).toBe('note.txt');
  });

  it('leaves the envelope out for an undefined body', () => {
    expect(buildDddFormData(undefined, { files: [file] }).has('body')).toBe(false);
  });
});

describe('mergeDddTagTypes', () => {
  const generated = ['Books', 'Prospectactivities'] as const;

  it('merges generated and own tags without duplicates', () => {
    const tags = mergeDddTagTypes([...generated, 'Books'], ['Session']);
    expect(tags).toEqual(['Books', 'Prospectactivities', 'Session']);
    const tag: (typeof tags)[number] = 'Session';
    // @ts-expect-error a tag that is in neither list
    const wrong: (typeof tags)[number] = 'ProspectActivities';
    expect([tag, wrong]).toHaveLength(2);
    expect(mergeDddTagTypes(generated)).toEqual(['Books', 'Prospectactivities']);
  });

  it('rejects an own tag that differs from a generated one only by case (compile time)', () => {
    // @ts-expect-error `ProspectActivities` next to the generated `Prospectactivities`
    mergeDddTagTypes(generated, ['ProspectActivities']);
    mergeDddTagTypes(generated, ['Books', 'Other']);
    expect(true).toBe(true);
  });
});
