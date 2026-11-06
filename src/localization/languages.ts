export interface SupportedLocale { code: string; name: string }
export interface SupportedLanguage { code: string; name: string; nativeName: string; locales: SupportedLocale[] }

/**
 * The languages this tool manages: Roblox's automatic-translation set. Roblox publishes no
 * per-language user shares, so the order is only an estimate of platform reach.
 * `localization read --all` still shows the live Roblox catalog.
 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: 'en', name: 'English', nativeName: 'English', locales: [{ code: 'en_us', name: 'English (United States)' }, { code: 'en_gb', name: 'English (United Kingdom)' }] },
  { code: 'es', name: 'Spanish', nativeName: 'Español', locales: [{ code: 'es_mx', name: 'Spanish (Mexico)' }, { code: 'es_es', name: 'Spanish (Spain)' }] },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', locales: [{ code: 'pt_br', name: 'Portuguese (Brazil)' }, { code: 'pt_pt', name: 'Portuguese (Portugal)' }] },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', locales: [{ code: 'ru_ru', name: 'Russian' }] },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', locales: [{ code: 'id_id', name: 'Indonesian' }] },
  { code: 'fr', name: 'French', nativeName: 'Français', locales: [{ code: 'fr_ca', name: 'French (Canada)' }, { code: 'fr_fr', name: 'French (France)' }] },
  { code: 'de', name: 'German', nativeName: 'Deutsch', locales: [{ code: 'de_de', name: 'German' }] },
  { code: 'ko', name: 'Korean', nativeName: '한국어', locales: [{ code: 'ko_kr', name: 'Korean' }] },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', locales: [{ code: 'ja_jp', name: 'Japanese' }] },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', locales: [{ code: 'it_it', name: 'Italian' }] },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', locales: [{ code: 'tr_tr', name: 'Turkish' }] },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', locales: [{ code: 'ar_001', name: 'Arabic' }] },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', locales: [{ code: 'th_th', name: 'Thai' }] },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', locales: [{ code: 'vi_vn', name: 'Vietnamese' }] },
  { code: 'pl', name: 'Polish', nativeName: 'Język Polski', locales: [{ code: 'pl_pl', name: 'Polish' }] },
  { code: 'zh-hans', name: 'Chinese (Simplified)', nativeName: '简体中文', locales: [{ code: 'zh_cn', name: 'Chinese (Simplified)' }] },
  { code: 'zh-hant', name: 'Chinese (Traditional)', nativeName: '繁體中文', locales: [{ code: 'zh_tw', name: 'Chinese (Traditional)' }] },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', locales: [{ code: 'hi_in', name: 'Hindi' }] },
];

export const SUPPORTED_LANGUAGE_CODES: readonly string[] = SUPPORTED_LANGUAGES.map(language => language.code);
const supported = new Set(SUPPORTED_LANGUAGE_CODES);

export function isSupportedLanguage(code: string): boolean { return supported.has(code); }
