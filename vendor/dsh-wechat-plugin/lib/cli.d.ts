/**
 * `dsh-wechat-send` — the command an agent's own script calls instead of the iLink API.
 *
 * The problem it exists for, in the words of the incident: asked to "send eleven messages, one every
 * three seconds", the agent wrote a script that read the token out of `state.json` and posted to the
 * service directly. Those sends were invisible to the channel, so the log showed one outbound message
 * while the phone got ten and then nothing — no counting, no request for a new window, and no queue
 * for what the platform refused.
 *
 * So the script gets a command to call instead. It shares the state file with the plugin, charges the
 * same reply-window ledger, warns the user at the same point, and queues a refused message for the
 * plugin to deliver when the user next writes. **The protocol is not reimplemented here** — every
 * outbound call is a `@dsh-wechat/core` function, the same one the plugin makes, which is the only
 * way the two can be trusted to behave identically.
 *
 * Exit codes are part of the interface, because a script has to tell the outcomes apart:
 *
 * | code | meaning |
 * |---|---|
 * | 0 | delivered now, possibly together with the "write me back" warning |
 * | 1 | a real failure: missing file, dead network, service error |
 * | 2 | unusable: bad arguments, or no bound conversation on this machine |
 * | 3 | refused by WeChat; **the message is queued**, not lost |
 *
 * @module dsh-wechat-plugin/cli
 */
import { type ChannelState, type QuotaLedger, type WeixinAccount } from '@dsh-wechat/core';
/** Delivered, or delivered together with the warning about the window. */
export declare const EXIT_OK = 0;
/** A real failure; retrying may help. */
export declare const EXIT_FAILED = 1;
/** Not usable: bad arguments, or nothing to send to. */
export declare const EXIT_USAGE = 2;
/**
 * WeChat refused the send, so it is queued for the next message the user sends.
 *
 * Its own code rather than a failure, because it is not one: the message is kept and will arrive. A
 * script that reads this as an error will retry, and every retry is refused the same way.
 */
export declare const EXIT_QUEUED = 3;
/** The account, peer and reply token a send needs, resolved from the bound conversation. */
export interface CliTarget {
    conversationId: string;
    account: WeixinAccount;
    peerId: string;
    contextToken?: string;
}
/**
 * Where the command gets everything it needs from the outside world.
 *
 * Injected so the whole command can be driven in a test without a network, a real state file, or a
 * child process. The counting, the warning and the queue are the parts that matter, and none of them
 * should need a live bot to be checked.
 */
export interface CliProvider {
    /** The state file shared with the plugin. */
    stateFile: string;
    /** The conversation to send to, or a reason it cannot be determined. */
    target(): Promise<{
        ok: true;
        target: CliTarget;
    } | {
        ok: false;
        message: string;
    }>;
    /** Charges the shared reply-window ledger. */
    quota: QuotaLedger;
    /** Delivers one already-built message. Defaults to the real iLink sender. */
    deliver?(request: {
        account: WeixinAccount;
        to: string;
        text: string;
        contextToken?: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    /** Uploads and delivers one attachment. Defaults to the real CDN upload plus item send. */
    attach?(request: {
        target: CliTarget;
        path: string;
        signal?: AbortSignal;
    }): Promise<{
        fileName: string;
        size: number;
    }>;
    /** Records one line for later diagnosis. Defaults to the channel's own boot log. */
    log?(line: string): void;
}
/** Streams {@link runCli} writes to. */
export interface CliIo {
    out(line: string): void;
    err(line: string): void;
}
/** Result of one command line. */
export interface CliOutcome {
    code: number;
    /** What was written — kept separate from the streams so a test can assert the wording. */
    out: string[];
    err: string[];
}
/** The usage text, shown by `--help` and after an unusable command line. */
export declare function helpText(): string;
/** One parsed command line. */
interface ParsedArgs {
    help: boolean;
    message?: string;
    file?: string;
    /** Positional arguments beyond the first, which is a usage error rather than something to guess at. */
    extra: string[];
    error?: string;
}
/**
 * Parse the command line.
 *
 * Hand-rolled rather than pulled from a dependency: the whole surface is one positional argument and
 * one option, and the messages have to be Chinese and actionable, which a generic parser's are not.
 *
 * @param argv - Arguments after the executable.
 * @returns The parsed command, or the reason it is unusable.
 */
export declare function parseArgs(argv: readonly string[]): ParsedArgs;
/**
 * Run one command line.
 *
 * @param argv - Arguments after the executable.
 * @param io - Where to write. Defaults to the process streams.
 * @param provider - Everything the command needs; the real one comes from {@link defaultCliProvider}.
 * @returns The exit code together with what was written, so a test needs no streams.
 */
export declare function runCli(argv: readonly string[], io?: CliIo, provider?: CliProvider): Promise<CliOutcome>;
/**
 * Resolve the conversation to send to.
 *
 * Read from the state file rather than taken as an argument, for the same reason `notify_wechat` takes
 * no target: the command runs inside a script whose author is guessing, and the one thing it must not
 * be able to do is reach a different conversation than the user is in.
 *
 * @param state - Persisted state.
 * @returns The target, or a reason it cannot be determined.
 */
export declare function boundTarget(state: ChannelState): {
    ok: true;
    target: CliTarget;
} | {
    ok: false;
    message: string;
};
/** Resolve the DSH home directory the way the plugin does, so both read one state file. */
export declare function resolveHome(): string;
/**
 * Append one line to the channel's boot log.
 *
 * The same file the plugin writes. A refusal and a lost file are the two things a later diagnosis
 * needs, and once the script has exited this log is the only place they can still be read.
 *
 * @param stateFile - The state file, whose directory holds the log.
 * @param line - Text to record.
 */
export declare function appendBootLog(stateFile: string, line: string): void;
/**
 * The real provider: the state file under `DSH_HOME`, the shared quota, and the core senders.
 *
 * Nothing here reaches the service on its own — every outbound call is a `@dsh-wechat/core` function,
 * which is what keeps this command and the plugin one implementation of the protocol.
 *
 * @param stateFile - Override for the state file. Absent in normal use.
 * @returns A provider ready to be driven.
 */
export declare function defaultCliProvider(stateFile?: string): CliProvider;
/**
 * Whether this module was started as a program, rather than imported by the launcher or a test.
 *
 * @param entry - `process.argv[1]`, injectable so the comparison itself can be tested.
 */
export declare function isDirectRun(entry?: string | undefined): boolean;
/**
 * Entry point, kept for a direct `node lib/cli.js` invocation.
 *
 * @param argv - Arguments after the executable.
 * @param io - Where to write.
 * @param provider - Override for tests.
 * @returns The exit code; a queued message is `3`, which is documented and not a failure.
 */
export declare function main(argv?: readonly string[], io?: CliIo, provider?: CliProvider): Promise<number>;
export {};
//# sourceMappingURL=cli.d.ts.map