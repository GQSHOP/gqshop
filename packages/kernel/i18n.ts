/**
 * i18n 地基（Phase 1 决策：文案 key 化，出海不得后补）。
 * 语言包在 locales/；服务端错误消息走 key + 参数插值。
 */
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };

export type Lang = "zh-CN" | "en";
export type MessageKey = keyof typeof zhCN;

const packs: Record<Lang, Record<string, string>> = {
  "zh-CN": zhCN,
  en,
};

export function t(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = packs[lang][key] ?? packs["zh-CN"][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}

/** 请求语言协商：?lang= / Accept-Language，默认 zh-CN。 */
export function langFrom(header: string | undefined, query: string | undefined): Lang {
  const q = query?.toLowerCase();
  if (q === "en" || q === "en-us") return "en";
  const h = header?.toLowerCase() ?? "";
  if (h.startsWith("en")) return "en";
  return "zh-CN";
}
