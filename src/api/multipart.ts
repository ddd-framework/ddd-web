/**
 * One file part: a `File` / `Blob` in a browser, or React Native's `{ uri, name, type }` file reference.
 */
export type DddFilePart = Blob | { uri: string; name: string; type: string };

/** File parts per form field of a DDD request DTO (its `Parameter::FILES` properties). */
export type DddMultipartFiles<Field extends string = string> = Partial<
  Record<Field, readonly DddFilePart[] | DddFilePart | null | undefined>
>;

/** Form field a DDD backend reads the JSON envelope of a multipart request from. */
export const DDD_MULTIPART_BODY_FIELD = 'body';

const partsOf = (value: readonly DddFilePart[] | DddFilePart | null | undefined): readonly DddFilePart[] => {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? (value as readonly DddFilePart[]) : [value as DddFilePart];
};

/** True when at least one file part is present. */
export function hasDddMultipartFiles(files: DddMultipartFiles | null | undefined): boolean {
  return !!files && Object.values(files).some((value) => partsOf(value).length > 0);
}

/**
 * The `multipart/form-data` body of a DDD request: the JSON envelope in the form field `body` (left out when
 * `body` is `undefined`) and every file as a part named `<field>[]`. No `Content-Type` header must be set for it: the
 * runtime adds the multipart boundary itself.
 */
export function buildDddFormData(body: unknown, files: DddMultipartFiles | null | undefined): FormData {
  const formData = new FormData();
  if (body !== undefined) formData.append(DDD_MULTIPART_BODY_FIELD, JSON.stringify(body));
  for (const [field, value] of Object.entries(files ?? {})) {
    for (const part of partsOf(value)) {
      const name = typeof (part as { name?: unknown }).name === 'string' ? (part as { name: string }).name : '';
      // A React Native file reference is appended as it is; a Blob without a name gets the field name.
      if (typeof Blob !== 'undefined' && part instanceof Blob) formData.append(`${field}[]`, part, name || field);
      else formData.append(`${field}[]`, part as unknown as Blob);
    }
  }
  return formData;
}

/**
 * Request body of an endpoint that accepts JSON and file parts: `body` itself while no file is given (a plain JSON
 * request), else the multipart form of {@link buildDddFormData}. Generated endpoints of operations with a
 * `multipart/form-data` request body call it with their `multipartFiles` argument.
 */
export function buildDddMultipartBody<Body>(body: Body, files: DddMultipartFiles | null | undefined): Body | FormData {
  return hasDddMultipartFiles(files) ? buildDddFormData(body, files) : body;
}
