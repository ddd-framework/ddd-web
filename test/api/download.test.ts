import { describe, expect, it } from 'vitest';
import {
  blobResponseHandler,
  createDownloadResponseHandler,
  filenameFromContentDisposition,
  type DddFileResponse,
} from '../../src/api';

describe('download helpers', () => {
  it('parses Content-Disposition file names', () => {
    expect(filenameFromContentDisposition('attachment; filename="report.xlsx"')).toBe('report.xlsx');
    expect(filenameFromContentDisposition('attachment; filename=plain.csv')).toBe('plain.csv');
    expect(filenameFromContentDisposition("attachment; filename=\"a.pdf\"; filename*=UTF-8''%C3%BCbersicht.pdf")).toBe(
      'übersicht.pdf',
    );
    expect(filenameFromContentDisposition('inline')).toBeNull();
    expect(filenameFromContentDisposition(null)).toBeNull();
  });

  it('blobResponseHandler returns blob + metadata, and parses error bodies as JSON', async () => {
    const ok = (await blobResponseHandler(
      new Response('abc', {
        headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="x.csv"' },
      }),
    )) as DddFileResponse;
    expect(ok.filename).toBe('x.csv');
    expect(ok.contentType).toBe('text/csv');
    expect(await ok.blob.text()).toBe('abc');

    const error = await blobResponseHandler(new Response('{"error":"Not found"}', { status: 404 }));
    expect(error).toEqual({ error: 'Not found' });
  });

  it('download handler is a no-op outside the browser and returns serializable metadata', async () => {
    const handler = createDownloadResponseHandler('fallback.bin');
    const result = await handler(new Response('12345'));
    expect(result).toEqual({ filename: 'fallback.bin', contentType: 'text/plain;charset=UTF-8', size: 5 });
  });
});
