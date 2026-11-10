import { describe, expect, it, vi } from 'vitest';
import { createDddBaseQuery, isDddUploadAborted, type DddBaseQueryOptions } from '../../src/api';
import type { DddTokens } from '../../src/auth';
import { json, makeApi } from './helpers';

interface SentUpload {
  method: string;
  url: string;
  headers: Record<string, string>;
  form: FormData;
}

/** A scripted XMLHttpRequest: each instance answers with the next entry of `answers`. */
const fakeXhr = (answers: Array<{ status: number; body?: unknown } | 'network' | 'hang'>) => {
  const sent: SentUpload[] = [];
  const create = (): XMLHttpRequest => {
    const xhr = {
      upload: {} as { onprogress?: (event: unknown) => void },
      status: 0,
      responseText: '',
      method: '',
      url: '',
      headers: {} as Record<string, string>,
      onload: undefined as undefined | (() => void),
      onerror: undefined as undefined | (() => void),
      onabort: undefined as undefined | (() => void),
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      },
      setRequestHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      abort() {
        this.onabort?.();
      },
      send(form: FormData) {
        sent.push({ method: this.method, url: this.url, headers: this.headers, form });
        const answer = answers.shift() ?? { status: 200, body: {} };
        if (answer === 'hang') return;
        queueMicrotask(() => {
          if (answer === 'network') return this.onerror?.();
          this.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 3 });
          this.status = answer.status;
          this.responseText = answer.body === undefined ? '' : JSON.stringify(answer.body);
          this.onload?.();
        });
      },
    };
    return xhr as unknown as XMLHttpRequest;
  };
  return { create, sent };
};

const setup = (answers: Parameters<typeof fakeXhr>[0], overrides: Partial<DddBaseQueryOptions> = {}) => {
  const tokens: DddTokens = { accessToken: 'old', refreshToken: 'r1' };
  const xhr = fakeXhr(answers);
  const fetchFn = vi.fn(async () => json(200, { accessToken: 'new', refreshToken: 'r2' }));
  const onLogout = vi.fn();
  const baseQuery = createDddBaseQuery({
    baseUrl: 'https://api.test/',
    refreshPath: '/api/client/common/auth/refresh',
    getTokens: () => tokens,
    setTokens: (next) => void Object.assign(tokens, next),
    onLogout,
    fetchOptions: { fetchFn },
    createUploadRequest: xhr.create,
    ...overrides,
  });
  return { baseQuery, xhr, fetchFn, onLogout, tokens };
};

const file = new File(['abc'], 'a.txt');

describe('createDddBaseQuery().upload', () => {
  it('sends the multipart form with bearer, hooks, params and progress', async () => {
    const { baseQuery, xhr } = setup([{ status: 200, body: { id: 7 } }], {
      languageCode: () => 'de',
      headers: (headers) => void headers.set('x-app', 'demo'),
    });
    const onProgress = vi.fn();
    const result = await baseQuery.upload(
      { url: '/api/client/items/5/files', body: { item: { title: 't' } }, files: { attachmentFiles: [file] }, params: { a: 1, b: null }, onProgress },
      makeApi('mutation'),
    );
    expect(result).toEqual({ data: { id: 7 } });
    const [request] = xhr.sent;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe('https://api.test/api/client/items/5/files?a=1');
    expect(request!.headers).toMatchObject({ authorization: 'Bearer old', languagecode: 'de', 'x-app': 'demo' });
    expect(request!.headers['content-type']).toBeUndefined();
    expect(JSON.parse(request!.form.get('body') as string)).toEqual({ item: { title: 't' } });
    expect((request!.form.get('attachmentFiles[]') as File).name).toBe('a.txt');
    expect(onProgress).toHaveBeenCalledWith(3, 3);
  });

  it('refreshes once after a 401 and repeats the upload with the new token', async () => {
    const { baseQuery, xhr, fetchFn, tokens } = setup([{ status: 401, body: { error: 'Unauthorized' } }, { status: 200, body: { ok: true } }]);
    const result = await baseQuery.upload({ url: '/api/client/files', files: { files: file } }, makeApi('mutation'));
    expect(result).toEqual({ data: { ok: true } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tokens.accessToken).toBe('new');
    expect(xhr.sent.map((request) => request.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('returns the backend error in the base query shape', async () => {
    const { baseQuery, fetchFn } = setup([{ status: 400, body: { error: 'Invalid file' } }]);
    const result = await baseQuery.upload({ url: '/api/client/files', files: { files: file } }, makeApi('mutation'));
    expect(result).toEqual({ error: { status: 400, data: { error: 'Invalid file' } } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports a network failure and a cancelled upload', async () => {
    const network = setup(['network']);
    const failed = await network.baseQuery.upload({ url: '/x', files: { files: file } }, makeApi('mutation'));
    expect(failed.error).toMatchObject({ status: 'FETCH_ERROR' });
    expect(isDddUploadAborted(failed.error)).toBe(false);

    const hanging = setup(['hang']);
    const controller = new AbortController();
    const pending = hanging.baseQuery.upload({ url: '/x', files: { files: file }, signal: controller.signal }, makeApi('mutation'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(isDddUploadAborted((await pending).error)).toBe(true);

    const early = new AbortController();
    early.abort();
    const never = await hanging.baseQuery.upload({ url: '/x', files: { files: file }, signal: early.signal }, makeApi('mutation'));
    expect(isDddUploadAborted(never.error)).toBe(true);
    expect(hanging.xhr.sent).toHaveLength(1);
  });
});
