/** A binary response decoded by {@link blobResponseHandler}. */
export interface DddFileResponse {
  blob: Blob;
  /** File name from `Content-Disposition`, else `null`. */
  filename: string | null;
  /** `Content-Type` of the response, else `null`. */
  contentType: string | null;
}

/** Serializable summary returned by {@link createDownloadResponseHandler} (safe to keep in the Redux store). */
export interface DddDownloadedFile {
  filename: string;
  contentType: string | null;
  size: number;
}

/**
 * Reads the file name from a `Content-Disposition` header. Prefers RFC 5987 `filename*=UTF-8''…` over `filename=`.
 *
 * @returns the decoded file name, or `null` when the header has none.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended?.[2]) {
    try {
      return decodeURIComponent(extended[2].trim().replace(/^"|"$/g, ''));
    } catch {
      // Malformed percent-encoding: fall back to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]*)/i.exec(header);
  const value = (plain?.[2] ?? plain?.[1] ?? '').trim();
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Triggers a browser download for an in-memory blob. No-op outside a browser.
 *
 * The anchor is attached before clicking (some browsers ignore detached anchors) and the object URL is revoked on the
 * next macrotask (revoking in the same task can cancel the download).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Parses an error response as JSON when possible, else as text, so error normalisation keeps working. */
const parseErrorBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * RTK Query `responseHandler` for binary endpoints: a successful response becomes a {@link DddFileResponse}, an error
 * response is parsed as JSON/text like any other error.
 *
 * Blobs are not serializable; keep such endpoints out of the cache (e.g. use a mutation or `keepUnusedDataFor: 0`) or
 * use {@link createDownloadResponseHandler}.
 *
 * @example
 * build.query<DddFileResponse, void>({ query: () => ({ url: '/export', responseHandler: blobResponseHandler }) })
 */
export async function blobResponseHandler(response: Response): Promise<DddFileResponse | unknown> {
  if (!response.ok) return parseErrorBody(response);
  return {
    blob: await response.blob(),
    filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
    contentType: response.headers.get('content-type'),
  } satisfies DddFileResponse;
}

/**
 * Builds an RTK Query `responseHandler` that downloads a successful binary response right away and resolves to a
 * serializable {@link DddDownloadedFile}. Error responses are parsed as JSON/text.
 *
 * @param fallbackFilename used when the response has no `Content-Disposition` file name
 */
export function createDownloadResponseHandler(fallbackFilename = 'download') {
  return async (response: Response): Promise<DddDownloadedFile | unknown> => {
    if (!response.ok) return parseErrorBody(response);
    const blob = await response.blob();
    const filename = filenameFromContentDisposition(response.headers.get('content-disposition')) ?? fallbackFilename;
    downloadBlob(blob, filename);
    return { filename, contentType: response.headers.get('content-type'), size: blob.size } satisfies DddDownloadedFile;
  };
}
