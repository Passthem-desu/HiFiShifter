import { enUS } from "./en-US";
import { zhCN } from "./zh-CN";
import { jaJP } from "./ja-JP";
import { koKR } from "./ko-KR";

export const messages = {
    "en-US": enUS,
    "zh-CN": zhCN,
    "ja-JP": jaJP,
    "ko-KR": koKR,
} as const;

export type Locale = keyof typeof messages;
export type MessageKey = keyof (typeof messages)["en-US"];
