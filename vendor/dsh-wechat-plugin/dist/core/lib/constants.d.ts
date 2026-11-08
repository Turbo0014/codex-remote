/**
 * Wire constants for the Tencent iLink Bot API — the backend behind the official
 * WeChat ClawBot plugin.
 *
 * Every value here was read out of Tencent's own channel implementation,
 * `@tencent-weixin/openclaw-weixin@2.4.10` (MIT), and then confirmed live against
 * the service from a third-party client. Values that the server itself hands
 * back at login (`baseurl`, `redirect_host`, `longpolling_timeout_ms`) are never
 * hardcoded except as fallbacks.
 *
 * @module @dsh-wechat/core/constants
 */
/** Fixed entry point for QR-code requests. Login may redirect elsewhere afterwards. */
export declare const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
/** Tenant/application id. Sent as `iLink-App-Id`. Mirrors the official `ilink_appid`. */
export declare const APP_ID = "bot";
/**
 * The official WeChat channel version this build declares to the iLink service.
 *
 * Not cosmetic: the service stamps the login QR with it, and the WeChat app refuses to bind a bot
 * whose interface version is older than the app supports. Tencent raises that floor with its own
 * releases, so a stale value blocks login outright instead of degrading. Taken from
 * `@tencent-weixin/openclaw-weixin@2.4.10` (MIT, published 2026-10-11), whose `src/api/api.ts`
 * derives both `base_info.channel_version` and `iLink-App-ClientVersion` from this one string.
 */
export declare const CHANNEL_VERSION = "2.4.10";
/**
 * Overrides {@link CHANNEL_VERSION} without a release.
 *
 * The failure this prevents is total — a QR the phone refuses cannot be bound at all — and the fix
 * is a number Tencent publishes with every release, so waiting for our next version is the wrong
 * trade. Set it to the current official channel version and restart DSH. A value the header cannot
 * encode is ignored rather than guessed at: a typo must not break every request.
 */
export declare const CHANNEL_VERSION_ENV = "DSH_WECHAT_ILINK_VERSION";
/** The version pair the wire declares: `base_info.channel_version` plus the client-version header. */
export interface IlinkVersion {
    /** Value of `base_info.channel_version`, for example `2.4.10`. */
    channelVersion: string;
    /** Value of `iLink-App-ClientVersion`, for example `132106`. */
    clientVersion: string;
}
/**
 * Encode a channel version the way the official client does.
 *
 * `iLink-App-ClientVersion` is a uint32 laid out as `0x00MMNNPP`. Tencent's own implementation
 * documents `1.0.11` → `0x0001000B` = `65547`, which is the encoding reproduced here; a literal
 * decimal such as the old `204009` is not one it can produce.
 *
 * @param version - Dotted channel version.
 * @returns The decimal string the header carries.
 * @throws {Error} When the version cannot be encoded.
 */
export declare function clientVersionOf(version: string): string;
/**
 * Resolve the version pair, honouring {@link CHANNEL_VERSION_ENV}.
 *
 * @param env - Environment to read, injectable so the fallback is testable without touching the
 *   process environment.
 * @returns Channel and header versions that are guaranteed to belong together.
 */
export declare function resolveIlinkVersion(env?: Record<string, string | undefined>): IlinkVersion;
/**
 * Self-declared bot identity reported in `base_info.bot_agent`.
 * Documented by Tencent as observability-only: it does not authenticate or route.
 */
export declare const DEFAULT_BOT_AGENT = "dsh-wechat/0.0.0";
/**
 * `bot_type` for the WeChat channel build.
 * Kept identical to the official value: the server may branch on it per client type.
 */
export declare const DEFAULT_BOT_TYPE = "3";
/** Server-suggested long-poll hold, used until the server sends its own value. */
export declare const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;
/** Client-side timeout for one QR-status long-poll. */
export declare const DEFAULT_QR_POLL_TIMEOUT_MS = 35000;
/** Timeout for ordinary (non-long-poll) calls such as `sendmessage`. */
export declare const DEFAULT_API_TIMEOUT_MS = 15000;
/** Local verification-code prompt must not hang a login forever. */
export declare const DEFAULT_LOGIN_TIMEOUT_MS: number;
/** How many times one login session may replace an expired QR code. */
export declare const MAX_QR_REFRESH = 3;
/** Restart backoff cap for the long-poll loop. */
export declare const MAX_LONG_POLL_BACKOFF_MS = 10000;
/** Base retry delay after a recoverable API failure. */
export declare const RETRY_DELAY_MS = 2000;
/** Delay after several consecutive failures. */
export declare const BACKOFF_DELAY_MS = 30000;
/** Consecutive API failures before backing off. */
export declare const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Server error code meaning the bot token is stale.
 *
 * Tencent's own client reacts by pausing every request for this account for one
 * hour before re-authentication, so a single expired token cannot storm the API.
 * We reproduce that cooldown rather than hot-looping.
 */
export declare const STALE_TOKEN_ERRCODE = -14;
/** Tencent's cooldown after {@link STALE_TOKEN_ERRCODE}. */
export declare const SESSION_PAUSE_MS: number;
/** CDN base for encrypted media. Media transfer arrives in phase 2. */
export declare const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
//# sourceMappingURL=constants.d.ts.map