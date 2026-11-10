/** The tags of `Extra` that differ from a tag of `Generated` only by case. */
type DddTagCaseConflict<Extra extends string, Generated extends string> = Extra extends Generated
  ? never
  : Lowercase<Extra> extends Lowercase<Generated>
    ? Extra
    : never;

type DddTagCheck<Generated extends readonly string[], Extra extends readonly string[]> = [
  DddTagCaseConflict<Extra[number], Generated[number]>,
] extends [never]
  ? unknown
  : { 'tag differs from a generated tag only by case': DddTagCaseConflict<Extra[number], Generated[number]> };

/**
 * The `tagTypes` of a base api: the generated tag lists (`<stem>TagTypes` of the `<stem>Tags.ts` files) plus the
 * app's own tags. With this list every `providesTags` / `invalidatesTags` of a hand-written endpoint and every
 * `api.util.invalidateTags()` is checked against the generated names, so a mistyped tag does not compile. An own tag
 * that differs from a generated one only by case (`ProspectActivities` next to the generated `Prospectactivities`)
 * is rejected here: it would be a second tag that no generated endpoint provides.
 *
 * @example
 * export const baseApi = createApi({
 *   baseQuery,
 *   tagTypes: mergeDddTagTypes([...adminApiTagTypes, ...clientApiTagTypes], ['Session']),
 *   endpoints: () => ({}),
 * });
 */
export function mergeDddTagTypes<const Generated extends readonly string[], const Extra extends readonly string[] = readonly []>(
  generated: Generated,
  extra?: Extra & DddTagCheck<Generated, Extra>,
): (Generated[number] | Extra[number])[] {
  return [...new Set<string>([...generated, ...(extra ?? [])])] as (Generated[number] | Extra[number])[];
}
