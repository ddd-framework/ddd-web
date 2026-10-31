/**
 * `DDD.Domain.Base.Entities.Translatable.TranslationInfos` and helpers around its translations store.
 */

/** Writing styles (`Translatable::WRITING_STYLE_*`). */
export type WritingStyle = 'FORMAL' | 'INFORMAL';

/**
 * Translation key `<languageCode>:<countryCode>:<writingStyle>` as built by
 * `TranslatableService::getTranslationIndexForLanguageCodeCountryCodeAndWritingStyle()`: language and country
 * lowercase, an absent country is empty, e.g. `en::FORMAL`, `de:at:INFORMAL`.
 */
export type TranslationKey = string;

/** Translations of one property: translation key → text. */
export type PropertyTranslations = Record<TranslationKey, string>;

/** `translationsStore`: property name → translation key → text. */
export type TranslationsStore = Record<string, PropertyTranslations>;

/** `TranslationInfos` as it appears in entity responses and requests (after {@link normalizeTranslationInfos}). */
export interface TranslationInfos {
  /** Translations per property. The wire sends `[]` for an empty store; use {@link normalizeTranslationsStore}. */
  translationsStore?: TranslationsStore;
  /** On persist, `true` replaces all stored translations instead of merging (JSON_MERGE_PATCH). */
  replaceExistingTranslations?: boolean;
  currentLanguageCode?: string;
  currentCountryCode?: string | null;
  currentWritingStyle?: WritingStyle;
  defaultLanguageCode?: string;
  defaultWritingStyle?: WritingStyle;
  /** Keys (language, locale, optionally `::style`) for which translations exist → `true`. */
  availableTranslations?: Record<string, boolean>;
  hasTranslationForCurrentLanguageCode?: boolean;
  hasTranslationForCurrentCountryCode?: boolean;
  hasTranslationForCurrentWritingStyle?: boolean;
  objectType?: string | null;
}

/** `TranslationInfos` as received on the wire: the maps may be empty arrays (`[]`). */
export type TranslationInfosWire = Omit<TranslationInfos, 'translationsStore' | 'availableTranslations'> & {
  translationsStore?: TranslationsStore | Record<string, PropertyTranslations | unknown[]> | unknown[] | null;
  availableTranslations?: Record<string, boolean> | unknown[] | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns the wire form of a translations store into a map. PHP serialises an empty associative array as `[]`
 * (`TranslationInfos::$translationsStore = []`, kept by the serializer), so an empty store — or an empty property
 * entry — arrives as `[]`; both become `{}`. `null`/`undefined` become `{}` as well. Non-string texts are dropped.
 */
export function normalizeTranslationsStore(store: unknown): TranslationsStore {
  if (!isPlainObject(store)) {
    return {};
  }
  const normalized: TranslationsStore = {};
  for (const [propertyName, translations] of Object.entries(store)) {
    const propertyTranslations: PropertyTranslations = {};
    if (isPlainObject(translations)) {
      for (const [key, text] of Object.entries(translations)) {
        if (typeof text === 'string') {
          propertyTranslations[key] = text;
        }
      }
    }
    normalized[propertyName] = propertyTranslations;
  }
  return normalized;
}

/** Normalises a wire `TranslationInfos`: `translationsStore` and `availableTranslations` become maps. */
export function normalizeTranslationInfos(infos: TranslationInfosWire): TranslationInfos {
  const availableTranslations: Record<string, boolean> = {};
  if (isPlainObject(infos.availableTranslations)) {
    for (const [key, available] of Object.entries(infos.availableTranslations)) {
      availableTranslations[key] = available === true;
    }
  }
  return {
    ...infos,
    translationsStore: normalizeTranslationsStore(infos.translationsStore),
    availableTranslations,
  };
}

/** Parts of a {@link TranslationKey}. */
export interface TranslationKeyParts {
  languageCode: string;
  countryCode?: string | null;
  writingStyle: WritingStyle;
}

/**
 * Builds a translation key the way the backend does
 * (`TranslatableService::getTranslationIndexForLanguageCodeCountryCodeAndWritingStyle()`):
 * `strtolower(language) . ':' . strtolower(country ?? '') . ':' . writingStyle`.
 */
export function buildTranslationKey(parts: TranslationKeyParts): TranslationKey {
  return `${parts.languageCode.toLowerCase()}:${(parts.countryCode ?? '').toLowerCase()}:${parts.writingStyle}`;
}

/** Splits a translation key into its parts; `null` when it is not `<language>:<country>:<style>`. */
export function parseTranslationKey(key: TranslationKey): TranslationKeyParts | null {
  const match = /^([^:]+):([^:]*):(FORMAL|INFORMAL)$/.exec(key);
  if (!match) {
    return null;
  }
  return {
    languageCode: match[1] as string,
    countryCode: match[2] ? match[2] : null,
    writingStyle: match[3] as WritingStyle,
  };
}
