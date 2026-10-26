import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
import nodePath from 'node:path';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import express, { type Express, type Request, type RequestHandler, type Response, type NextFunction } from 'express';

import { createOAuth2Server, type OAuth2Model } from '@iobroker/webserver';
import {
    McpServer as McpSdkServer,
    ResourceTemplate,
    type RegisteredTool,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    isInitializeRequest,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAiFriendlyStructure, type Room } from './devices';
import { iobUriParse } from './iob-uri';
import { PERMISSION_KEYS, type McpConfig, type McpPermissions } from './types';
import { createInProcessMcp } from './inProcessClient';
import packageJson from '../package.json';

const SERVER_NAME = 'iobroker-mcp';
const SERVER_VERSION = packageJson.version;

/** Result shape expected by the MCP SDK tool callbacks. */
type ToolResult = {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
};

/**
 * Express request after the shared ioBroker OAuth2 `authorize` middleware ran. `user` holds the
 * plain ioBroker user name (without the `system.user.` prefix) when a valid credential — a Bearer
 * access token, an `access_token` cookie, or HTTP Basic auth — was presented; otherwise it is unset.
 */
type AuthenticatedRequest = Request & { user?: string };

/** Map the human-friendly aggregation names from the manifest to ioBroker history values. */
const AGG_MAP: Record<string, ioBroker.GetHistoryOptions['aggregate']> = {
    raw: 'none',
    min: 'min',
    max: 'max',
    avg: 'average',
    sum: 'total',
    count: 'count',
    minmax: 'minmax',
    percentile: 'percentile',
    quantile: 'quantile',
    integral: 'integral',
};
const WEB_EXTENSION_PREFIX = 'mcp/';
/** Arguments of tool calls whose values are not written to the log, besides file contents (may hold secrets). */
const LOG_HIDDEN_ARGS: Record<string, string[]> = {
    send_to: ['message'],
    set_script: ['source'],
    run_script: ['source'],
};
/** Values of tool arguments are cut after this many characters in the log. */
const LOG_ARG_LENGTH = 200;

type Rights = ioBroker.PermissionSet;
const objectWrite = (rights: Rights): boolean => !!rights.object?.write;
const fileWrite = (rights: Rights): boolean => !!rights.file?.write;
const execute = (rights: Rights): boolean => !!rights.other?.execute;
const sendTo = (rights: Rights): boolean => !!rights.other?.sendto;
/**
 * The general rights (of the groups of the ioBroker user) without which a tool cannot succeed: such tools are not
 * offered to the sessions of the user. Tools not listed here are offered to everyone.
 */
const TOOL_RIGHTS: Record<string, (rights: Rights) => boolean> = {
    set_state: rights => !!rights.state?.write,
    set_states: rights => !!rights.state?.write,
    set_object: objectWrite,
    create_state: objectWrite,
    create_scene: objectWrite,
    create_alias: objectWrite,
    delete_object: rights => !!rights.object?.delete,
    write_file: fileWrite,
    rename_file: fileWrite,
    mkdir: fileWrite,
    delete_file: rights => !!rights.file?.delete,
    start_instance: objectWrite,
    stop_instance: objectWrite,
    restart_instance: objectWrite,
    // persistently in the instance object, or temporarily in its logLevel state
    set_log_level: rights => objectWrite(rights) || !!rights.state?.write,
    add_instance: execute,
    delete_instance: execute,
    upgrade_adapter: execute,
    install_package: execute,
    // for write_file or install_package
    prepare_upload: rights => fileWrite(rights) || execute(rights),
    set_script: objectWrite,
    enable_script: objectWrite,
    delete_script: rights => !!rights.object?.delete,
    run_script: sendTo,
    send_to: sendTo,
};
/** Default time `wait_for_state` waits (seconds). */
const DEFAULT_WAIT_TIMEOUT = 30;
/** Longest wait of `wait_for_state` and `set_state` (seconds): many MCP clients give up on a call after 60 s. */
const MAX_WAIT_TIMEOUT = 50;
/** How often a state is read while waiting for it (ms). */
const STATE_POLL_INTERVAL = 250;

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** True when the bind address only accepts connections from this machine (127.0.0.0/8, ::1, localhost). */
function isLoopbackBind(bind: string | undefined): boolean {
    const address = (bind || '')
        .trim()
        .toLowerCase()
        .replace(/^\[(.*)]$/, '$1');
    if (address === 'localhost') {
        return true;
    }
    const family = net.isIP(address);
    return !!family && LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Languages offered for localized names. */
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'] as const;

/** Localize an ioBroker name to a plain string for the given language. */
function getText(text: ioBroker.StringOrTranslated | undefined, language: ioBroker.Languages): string {
    if (!text) {
        return '';
    }
    if (typeof text === 'string') {
        return text;
    }
    return text[language] || text.en || '';
}

/** Loose view over an object's `common` for cross-type metadata access. */
type AnyCommon = {
    name?: ioBroker.StringOrTranslated;
    color?: string;
    icon?: string;
    type?: ioBroker.CommonType;
    role?: string;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    members?: string[];
};

interface EnumItem {
    id: string;
    name: ioBroker.StringOrTranslated;
    type: ioBroker.ObjectType;
    color?: string;
    icon?: string;
    stateType?: ioBroker.CommonType;
    role?: string;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
}
interface EnumResponse {
    id: string;
    name: ioBroker.StringOrTranslated;
    color?: string;
    icon?: string;
    items: EnumItem[];
}

/**
 * MCP (Model Context Protocol) server for ioBroker.
 *
 * Exposes ioBroker functionality as MCP tools over the "Streamable HTTP" transport
 * (POST/GET/DELETE on `/mcp`). Each client session gets its own SDK server instance
 * and transport, tracked by the `Mcp-Session-Id` header.
 */
/** Per-session context: its transport, SDK server and the set of subscribed resource URIs. */
interface SessionContext {
    transport: StreamableHTTPServerTransport;
    server: McpSdkServer;
    /** Canonical ioBroker URIs this session subscribed to (e.g. iobstate://id, iobobject://id, ioblog://all). */
    subscriptions: Set<string>;
    /** The ioBroker user that opened the session; all its requests run with this user's permissions. */
    user: `system.user.${string}`;
}

/** URI prefix for the (non-standard, ioBroker-specific) log stream resource. */
const LOG_URI_PREFIX = 'ioblog://';
/** How many recent log lines to keep for `ioblog://` resource reads. */
const LOG_BUFFER_SIZE = 200;
/**
 * Default maximum number of file bytes a single `read_file` call returns.
 * MCP clients (e.g. Claude.ai / Claude Desktop) reject tool results above 1 MiB; the content is embedded in a
 * JSON string (escaping) or base64 (+33%), so 512 KiB of raw data keeps the wrapped result safely below that cap.
 */
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
/** Default time `install_package` waits for the installation to finish (seconds). */
const DEFAULT_INSTALL_TIMEOUT = 300;
/** How many output lines of an installation are returned to the client. */
const INSTALL_OUTPUT_LINES = 100;
/** Default time `install_package` waits for the restarted instances to come up (seconds). */
const DEFAULT_START_TIMEOUT = 20;
/** How many log lines of a restarted instance `install_package` returns. */
const START_LOG_LINES = 10;
/** A log whose newest line is older than this (ms) gets a hint that it may no longer be written. */
const STALE_LOG_AGE = 30 * 60_000;
/** The "everyone" read bit of an ioBroker ACL; the group and owner bits are shifted by 4 and 8. */
const ACL_READ = 0x4;
/** The "everyone" write bit of an ioBroker ACL; the group and owner bits are shifted by 4 and 8. */
const ACL_WRITE = 0x2;

/**
 * Maximum size of a tool result. MCP clients (Claude.ai / Claude Desktop / Claude Code) reject results above
 * 1 MiB, measured on the JSON-RPC message, in which the result text is escaped once more.
 */
const MAX_RESULT_BYTES = 900 * 1024;
/** How long a download or upload link stays valid (ms). */
const TRANSFER_TTL = 15 * 60_000;
/** Largest file that can be uploaded through a link (it travels base64-encoded in a message to the host). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Size of a text inside the JSON-RPC message, where it is escaped once more. */
function wireSize(text: string): number {
    return Buffer.byteLength(JSON.stringify(text));
}

/** A part of a list that fits into a tool result. */
interface Page<T> {
    items: T[];
    total: number;
    offset: number;
    nextOffset?: number;
    truncated: boolean;
}

/**
 * Take the items from `offset` on, as many as fit into a tool result next to the rest of the answer.
 * With `fromEnd`, the last items are kept instead (the newest log lines).
 */
function fitItems<T>(all: T[], offset = 0, fromEnd = false): Page<T> {
    const budget = MAX_RESULT_BYTES - 16 * 1024;
    const items = all.slice(offset);
    let size = 0;
    let count = 0;
    while (count < items.length) {
        const item = items[fromEnd ? items.length - 1 - count : count];
        size += wireSize(JSON.stringify(item)) + 1;
        if (size > budget) {
            break;
        }
        count++;
    }
    if (count === items.length) {
        return { items, total: all.length, offset, truncated: false };
    }
    return fromEnd
        ? { items: items.slice(items.length - count), total: all.length, offset, truncated: true }
        : { items: items.slice(0, count), total: all.length, offset, nextOffset: offset + count, truncated: true };
}

/** A download or upload link, see `McpServer.createTransfer`. */
interface Transfer {
    kind: 'download' | 'upload';
    /** File name as the client gave or gets it */
    name: string;
    /** The temporary file */
    file: string;
    contentType: string;
    /** When the link expires (ms) */
    expires: number;
    /** Size in bytes; undefined for an upload link that was not used yet */
    size?: number;
    /** The user that created the link; only this user can use an upload in a tool */
    user: `system.user.${string}`;
}

/** A running `cmdExec` on a host, started by `install_package`. */
interface CmdSession {
    /** Collected stdout/stderr lines, in the order they arrived */
    output: string[];
    /** Called with the exit code once the host reports `cmdExit` */
    onExit: (exitCode: number) => void;
}

/**
 * Extract the adapter name from an install source, like `iobroker.admin-7.8.6.tgz`,
 * `ioBroker/ioBroker.admin#main`, `iobroker.admin@7.8.6` or `admin`. Same rules as in ioBroker.admin.
 */
function extractAdapterName(source: string): string | null {
    // cut off the query string and the anchor, like in `.../ioBroker.xyz/tarball/main?token=1`
    const url = source.trim().split('?')[0].split('#')[0];

    const packed = url.match(/iobroker\.([a-z\d][a-z\d_-]*?)-\d+\.\d+\.\d+[^/\\]*\.tgz$/i);
    if (packed) {
        return packed[1].toLowerCase();
    }
    const named = url.match(/iobroker\.([a-z\d][a-z\d_-]*)/i);
    if (named) {
        return named[1].toLowerCase();
    }
    if (/^[a-z\d][a-z\d_-]*$/i.test(url)) {
        return url.toLowerCase();
    }
    return null;
}

/**
 * Compare two versions like `3.9.0` and `3.10.0-alpha.1`: > 0 if `a` is newer, < 0 if `b` is newer.
 * A pre-release is older than the release with the same numbers.
 */
function compareVersions(a: string, b: string): number {
    const [mainA, preA] = (a || '0').split('-', 2);
    const [mainB, preB] = (b || '0').split('-', 2);
    const partsA = mainA.split('.').map(part => parseInt(part, 10) || 0);
    const partsB = mainB.split('.').map(part => parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const diff = (partsA[i] || 0) - (partsB[i] || 0);
        if (diff) {
            return diff;
        }
    }
    if (preA === preB) {
        return 0;
    }
    if (!preA || !preB) {
        return preA ? -1 : 1;
    }
    return preA.localeCompare(preB, undefined, { numeric: true });
}

export default class McpServer {
    private readonly adapter: ioBroker.Adapter;
    /** The Express app we attach routes to. Undefined in embedded in-process mode (no HTTP). */
    private readonly app?: Express;
    /** Active sessions keyed by session id. */
    private readonly sessions: Record<string, SessionContext> = {};
    /** Ref-count of adapter-level subscriptions across all sessions, keyed by "<type>:<address>" or "log". */
    private readonly subscriptionCounts: Record<string, number> = {};
    /** Recent log lines kept for `ioblog://` resource reads (filled while there are log subscribers). */
    private readonly logBuffer: ioBroker.LogMessage[] = [];
    /** The tools of every server created by {@link createServer}, for {@link hideToolsWithoutRights}. */
    private readonly registeredTools = new WeakMap<McpSdkServer, Map<string, RegisteredTool>>();
    private config: McpConfig;
    private readonly extension: boolean;
    private readonly routerPrefix: string;
    /** The ioBroker user whose permissions MCP requests run with when no user is logged in. */
    private readonly defaultUser: `system.user.${string}`;
    /** The user of the MCP request being processed, set by {@link runAs} for each HTTP request. */
    private readonly requestUser = new AsyncLocalStorage<`system.user.${string}`>();
    /** Default language used to localize device/room/function names. */
    private readonly language: ioBroker.Languages;
    /**
     * Whether this instance has to authenticate incoming MCP requests itself. True only in standalone
     * mode with authentication enabled; as a web extension the host `web` adapter guards the routes.
     */
    private readonly authRequired: boolean;
    /**
     * Whether *we* run the OAuth2 authorization server (login and consent pages, token issuance).
     * Standalone mode only — as a web extension the host `web` instance owns those endpoints.
     */
    private readonly oauthProvider: boolean;
    /**
     * Whether the MCP endpoint is an OAuth-protected resource: we publish its metadata (RFC 9728),
     * point clients at the authorization server in the `401`, and reject tokens minted for something
     * else. True in standalone mode and as a web extension alike.
     */
    private readonly oauthResource: boolean;
    /** OAuth2 login/token server, created only when {@link authRequired} is true. */
    private oauth2?: OAuth2Model;
    /** Installations started by `install_package`, keyed by the `cmdExec` session id. */
    private readonly cmdSessions = new Map<string, CmdSession>();
    /** Path of the MCP endpoint, e.g. `/mcp`. */
    private readonly mcpPath: string;
    /**
     * Whether tools may hand out download/upload links (`<mcp>/transfer/<token>`). Needs our own HTTP
     * routes; not as a web extension with authentication, where the web adapter asks for a login first.
     */
    private readonly linksAvailable: boolean;
    /** Why links are not available, for the answer of the tools. */
    private readonly linksUnavailableReason: string;
    /** Active download and upload links, keyed by their token. */
    private readonly transfers = new Map<string, Transfer>();
    /** Temporary folder for the files of the links, created on first use. */
    private transferDir?: string;
    private transferTimer?: NodeJS.Timeout;

    constructor(
        server: HttpServer | HttpsServer | null,
        // The permission toggles are explicit overrides for embedded mode (see `McpPermissions`)
        webSettings: {
            // `secure`/`port`/`auth` are accepted for backwards compatibility but not read here;
            // the HTTP specifics come from the adapter config. `defaultUser` accepts a plain user
            // name or a fully qualified `system.user.*` id — it is normalized below either way.
            secure?: boolean;
            port?: number | string;
            defaultUser?: string;
            auth?: boolean;
            language?: ioBroker.Languages;
        } & Partial<McpPermissions>,
        adapter: ioBroker.Adapter,
        instanceSettings: ioBroker.InstanceObject | null,
        app?: Express,
    ) {
        this.app = app;
        this.adapter = adapter;
        // Clone the source config so we never mutate the host adapter's config object — important in
        // embedded in-process mode, where `adapter` is a foreign adapter (e.g. admin), not mcp itself.
        this.config = {
            ...((instanceSettings ? instanceSettings.native : adapter.config) as McpConfig),
        };
        this.extension = !!instanceSettings;
        this.routerPrefix = this.extension ? `/${WEB_EXTENSION_PREFIX}` : '/';
        // In standalone mode this is `/mcp`; as a web extension we own the `/<adapter>/` namespace
        // (e.g. `/mcp/`) within the shared web server, and strip the trailing slash so the route
        // matches both `/mcp` and `/mcp/` (Express, non-strict).
        this.mcpPath = this.extension ? this.routerPrefix.replace(/\/$/, '') : '/mcp';

        // Determine the ioBroker user whose permissions unauthenticated MCP requests run with.
        // As a web extension the host `web` instance decides about authentication, so its default
        // user wins there; otherwise prefer this adapter's own setting. Finally fall back to "admin".
        const rawUser =
            (this.extension
                ? webSettings.defaultUser || this.config.defaultUser
                : this.config.defaultUser || webSettings.defaultUser) || 'admin';
        this.defaultUser = McpServer.toUserId(rawUser);
        this.config.defaultUser = this.defaultUser;
        this.language = webSettings.language || 'en';

        // Embedded callers may set the permission toggles explicitly (they don't read the mcp config).
        for (const key of PERMISSION_KEYS) {
            if (webSettings[key] !== undefined) {
                (this.config as Partial<McpPermissions>)[key] = webSettings[key] as any;
            }
        }
        // Permission toggles: state writes are allowed by default, everything that changes the
        // system (objects, instances, adapters, packages, scripts, messages) is not.
        this.config.allowSetState = this.config.allowSetState !== false;
        this.config.allowObjectChange = this.config.allowObjectChange === true;
        this.config.allowInstanceControl = this.config.allowInstanceControl === true;
        this.config.allowAdapterManagement = this.config.allowAdapterManagement === true;
        this.config.allowPackageInstall = this.config.allowPackageInstall === true;
        this.config.allowScriptChange = this.config.allowScriptChange === true;
        this.config.sendToAllowlist = (this.config.sendToAllowlist || '').trim();
        // Confirmations via elicitation are on unless turned off explicitly
        this.config.confirmDangerous = this.config.confirmDangerous !== false;
        this.config.transferLinks = this.config.transferLinks !== false;
        if (!this.app) {
            this.linksUnavailableReason = 'Links need the HTTP server of MCP, they are not available in this mode';
        } else if (!this.config.transferLinks) {
            this.linksUnavailableReason =
                'Links are turned off in the MCP adapter settings ("Allow download/upload links")';
        } else if (this.extension && webSettings.auth) {
            this.linksUnavailableReason =
                'Links are not available as a web extension with authentication enabled in the web adapter';
        } else {
            this.linksUnavailableReason = '';
        }
        this.linksAvailable = !this.linksUnavailableReason;
        if (this.linksAvailable) {
            this.removeStaleTransferDirs();
        }
        // State writes are declared destructive unless turned off explicitly
        this.config.setStateDestructive = this.config.setStateDestructive !== false;

        // Authentication is enforced by us only when we run standalone (we own the Express app) and
        // the user turned it on. As a web extension (`this.extension`) the host `web` adapter already
        // authenticates every request before it reaches our routes, and in embedded in-process mode
        // there is no HTTP layer at all (`this.app` is undefined).
        this.authRequired = !this.extension && !!this.app && !!this.config.auth;
        // We run the authorization server ourselves only when we own the Express app — it needs
        // `/oauth/*` and `/.well-known/oauth-authorization-server` at the origin root.
        this.oauthProvider = this.authRequired && !!this.config.oauth;
        // We act as an OAuth-protected resource in both HTTP modes: standalone on top of our own
        // authorization server, and as a web extension on top of the host `web` instance's one. In
        // both cases we publish the resource metadata for our endpoint and verify the audience.
        this.oauthResource = !!this.app && !!this.config.oauth && (this.authRequired || this.extension);
        if (this.config.oauth && !this.oauthResource && !!this.app) {
            this.adapter.log.warn(
                'OAuth is configured but ignored: it requires "Enable Authentication" in standalone mode',
            );
        }
        if (this.oauthResource && this.extension) {
            this.adapter.log.info(
                'MCP OAuth as a web extension: the host "web" instance provides the authorization server, ' +
                    'so OAuth must be enabled there as well',
            );
        }

        // Receive ioBroker log messages (only forwarded once a session subscribes via requireLog).
        this.adapter.on('log', this.onLog);
        if (this.config.allowPackageInstall || this.config.allowAdapterManagement) {
            // The host reports the progress of `cmdExec` (install_package etc.) as messages to this instance
            this.adapter.on('message', this.onMessage);
        }

        // Wire HTTP routes only when we own/share an Express app. In embedded in-process mode (no app)
        // the server is reached over an in-memory transport instead, see createInProcessServer().
        this.initRoutes();
    }

    /**
     * Build a fresh MCP SDK server with all ioBroker tools registered, ready to be connected to an
     * arbitrary transport. Used for in-process embedding (e.g. by ioBroker.admin) over an
     * InMemoryTransport, where there is no HTTP server/session layer. The caller owns the lifecycle
     * of the returned server (connect it to a transport, and `close()` it when done). Call
     * {@link hideToolsWithoutRights} before connecting it to offer only the tools the user may use.
     */
    createInProcessServer(): McpSdkServer {
        return this.createServer(new Set<string>());
    }

    /**
     * Do not offer the tools the user cannot use, because its groups lack a general right the tool needs (e.g.
     * `install_package` without "execute"), so the client does not try them in vain. Administrators get all
     * tools. The rights are read once, before the server is connected: changed rights apply to new sessions,
     * and every call is checked anyway.
     *
     * @param server a server returned by {@link createInProcessServer}
     * @param user the ioBroker user of the session (default: the configured default user)
     * @returns the names of the hidden tools
     */
    async hideToolsWithoutRights(
        server: McpSdkServer,
        user: `system.user.${string}` = this.defaultUser,
    ): Promise<string[]> {
        const tools = this.registeredTools.get(server);
        if (!tools || user === 'system.user.admin') {
            return [];
        }
        let rights: Rights;
        try {
            rights = await this.adapter.calculatePermissionsAsync(user, []);
        } catch (e) {
            this.adapter.log.warn(
                `Cannot read the rights of ${user}, all tools are offered: ${e instanceof Error ? e.message : e}`,
            );
            return [];
        }
        if (rights.groups?.includes('system.group.administrator')) {
            return [];
        }
        const hidden: string[] = [];
        for (const [name, tool] of tools) {
            if (TOOL_RIGHTS[name] && !TOOL_RIGHTS[name](rights)) {
                tool.disable();
                hidden.push(name);
            }
        }
        if (hidden.length) {
            this.adapter.log.debug(`MCP tools not offered to ${user} for lack of rights: ${hidden.join(', ')}`);
        }
        return hidden;
    }

    /**
     * Convenience factory for embedding the MCP server inside another adapter's process (no HTTP).
     * The returned instance is not wired to any Express app; obtain a tool server via
     * {@link createInProcessServer} and connect it to an in-memory transport.
     *
     * @param options embedding options (host adapter, default user, language, permission toggles)
     * @param options.adapter The host adapter into which the MCP server is embedded. Used for receiving state/object changes and logs, and for performing actions with the host adapter's permissions.
     * @param options.defaultUser Default user
     * @param options.language Language
     */
    static createEmbedded(
        options: {
            adapter: ioBroker.Adapter;
            defaultUser?: `system.user.${string}`;
            language?: ioBroker.Languages;
        } & Partial<McpPermissions>,
    ): McpServer {
        const { adapter, ...settings } = options;
        return new McpServer(null, { secure: false, port: 0, ...settings }, adapter, null);
    }

    private initRoutes(): void {
        const app = this.app;
        if (!app) {
            // Embedded in-process mode: no HTTP transport, so there is nothing to route.
            return;
        }
        const mcpPath = this.mcpPath;
        // The MCP transport needs a parsed JSON body; apply the parser per-route so we never
        // touch the body handling of the web adapter or other extensions when running embedded.
        const jsonParser = express.json({ limit: '4mb' });

        // Health endpoint inside our own namespace (`/status` standalone, `/mcp/status` embedded).
        app.get(`${this.routerPrefix}status`, (_req: Request, res: Response) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: Date.now(),
                sessions: Object.keys(this.sessions).length,
            });
        });

        // Global middleware and root/info endpoints only when we own the whole app (standalone).
        // As an extension these would collide with the web adapter's own routes.
        if (!this.extension) {
            app.use((req: Request, _res: Response, next: NextFunction) => {
                // The token of a transfer link is a credential, so it does not go into the log
                const url = req.url.replace(/\/transfer\/[^/?]+/, '/transfer/***');
                this.adapter.log.debug(`${req.method} ${url} from ${req.ip}`);
                next();
            });

            app.get('/', (_req: Request, res: Response) => {
                res.json({
                    name: 'ioBroker MCP Server',
                    version: SERVER_VERSION,
                    status: 'running',
                    mcpEndpoint: '/mcp',
                });
            });

            app.get('/api/info', (_req: Request, res: Response) => {
                res.json({
                    adapter: 'mcp',
                    version: SERVER_VERSION,
                    secure: this.config.secure,
                    auth: this.config.auth,
                });
            });
        }

        // --- Authentication (standalone mode only) ---
        // As a web extension the host `web` adapter owns authentication for every route (ours
        // included), so installing a second OAuth2 server here would clash with it. When we run
        // standalone and the user enabled authentication, protect the MCP endpoint with the shared
        // ioBroker OAuth2 login: clients present a Bearer access token (obtained from
        // `POST /oauth/token`), an `access_token` cookie, or HTTP Basic auth (`user:password`).
        if (this.authRequired) {
            // The OAuth2 token endpoint (added by createOAuth2Server) needs its request body parsed.
            // Scope the parser to that path so the MCP transport keeps its own body handling.
            app.use('/oauth/token', express.urlencoded({ extended: false }), express.json());
            // The OAuth2 server only logs the user name of a wrong password; tell which client it was
            app.use(this.logFailedLogin);
            this.oauth2 = createOAuth2Server(this.adapter, {
                app,
                secure: !!this.config.secure,
                // Permit HTTP Basic auth so headless MCP clients can send `user:password` directly,
                // in addition to obtaining a Bearer access token from `POST /oauth/token`.
                noBasicAuth: false,
                // Browser-based login/consent for MCP clients that must not see the user's password.
                authorizationCode: this.oauthProvider,
                baseUrl: this.config.publicUrl || undefined,
                dynamicClientRegistration: this.config.oauthDynamicRegistration !== false,
                productName: 'ioBroker MCP',
            });
            this.adapter.log.info(
                'MCP authentication is enabled: requests to the MCP endpoint must present valid ioBroker credentials',
            );

            if (this.oauthProvider) {
                this.adapter.log.info(
                    'MCP OAuth is enabled: clients can connect through a browser login at /oauth/authorize',
                );
            }
        } else if (!this.extension && !this.config.auth && !isLoopbackBind(this.config.bind)) {
            // Bound to a loopback address, the endpoint is unreachable from the network, so skip the warning
            this.adapter.log.warn(
                'MCP authentication is disabled: the MCP endpoint is reachable without credentials. ' +
                    'Enable "Authentication" in the adapter settings when the port is exposed to untrusted networks.',
            );
        }

        // --- OAuth protected resource metadata (RFC 9728) ---
        // Tells the client which authorization server guards this endpoint. Clients derive the path
        // from the resource path, so `/mcp` is looked up under `/.well-known/oauth-protected-resource/mcp`.
        if (this.oauthResource) {
            const sendResourceMetadata = (req: Request, res: Response): void => {
                const baseUrl = this.getBaseUrl(req);
                res.set('Cache-Control', 'public, max-age=300');
                res.json({
                    resource: `${baseUrl}${mcpPath}`,
                    authorization_servers: [baseUrl],
                    bearer_methods_supported: ['header'],
                    resource_name: 'ioBroker MCP',
                });
            };
            app.get(`/.well-known/oauth-protected-resource${mcpPath}`, sendResourceMetadata);
            if (!this.extension) {
                // Older clients ask for the bare path. Only standalone: as an extension this document
                // describes the whole web server, which is not ours to answer for.
                app.get('/.well-known/oauth-protected-resource', sendResourceMetadata);
            }

            if (!this.config.publicUrl) {
                this.adapter.log.info(
                    'No public URL configured — OAuth discovery URLs are derived from each request. ' +
                        'Set it when this server runs behind a reverse proxy.',
                );
            }
            if (!this.extension && !this.config.secure && !this.config.publicUrl?.startsWith('https://')) {
                this.adapter.log.warn(
                    'MCP OAuth without HTTPS: remote MCP clients refuse plain http:// and will not be able to connect. ' +
                        'Enable SSL or put this server behind an https reverse proxy.',
                );
            }
        }

        // --- MCP Streamable HTTP transport ---
        // When authentication is required, `authGuard` runs first and rejects any request that the
        // OAuth2 `authorize` middleware could not associate with a user. As a web extension the host
        // already did that, but we still guard the endpoint to verify the token's audience.
        const guards: RequestHandler[] = this.authRequired || this.oauthResource ? [this.authGuard] : [];
        app.post(mcpPath, ...guards, jsonParser, (req: Request, res: Response) => {
            void this.handleMcpPost(req, res);
        });
        app.get(mcpPath, ...guards, (req: Request, res: Response) => {
            void this.handleMcpSessionRequest(req, res);
        });
        app.delete(mcpPath, ...guards, (req: Request, res: Response) => {
            void this.handleMcpSessionRequest(req, res);
        });

        // --- Download and upload links (see createTransfer) ---
        // No guards: the random token in the path is the credential. An authenticated MCP session got
        // it from a tool and hands it to a program without MCP access, e.g. curl in a shell.
        if (this.linksAvailable) {
            app.get(`${mcpPath}/transfer/:token`, (req: Request, res: Response) => this.handleDownload(req, res));
            app.put(`${mcpPath}/transfer/:token`, (req: Request, res: Response) => {
                void this.handleUpload(req, res);
            });
            app.post(`${mcpPath}/transfer/:token`, (req: Request, res: Response) => {
                void this.handleUpload(req, res);
            });
        }

        // Catch-all 404 + error handlers only in standalone mode; the web adapter provides its own.
        if (!this.extension) {
            app.use((req: Request, res: Response) => {
                res.status(404).json({ error: 'Not Found', path: req.url });
            });

            app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
                this.adapter.log.error(`Server error: ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal Server Error', message: err.message });
                }
            });
        }
    }

    /**
     * Guard for the MCP endpoint when authentication is enabled (standalone mode). By the time this
     * runs, the global OAuth2 `authorize` middleware installed by {@link createOAuth2Server} has
     * already populated `req.user` from a Bearer token, an `access_token` cookie or HTTP Basic auth
     * — and answered with 401 itself if a *wrong* credential was supplied. A request with *no*
     * credential, however, falls through `authorize` with `req.user` still unset, so here we reject
     * anything that could not be tied to an authenticated ioBroker user.
     */
    private authGuard = (req: Request, res: Response, next: NextFunction): void => {
        void this.checkAuthentication(req, res, next);
    };

    /**
     * Log the address and the User-Agent of a request with a rejected password (HTTP Basic auth or the
     * password grant of `POST /oauth/token`), so a client that keeps retrying can be found. Rejected tokens
     * (e.g. expired ones, which clients refresh) are only logged in debug.
     */
    private logFailedLogin = (req: Request, res: Response, next: NextFunction): void => {
        const authorization = req.headers.authorization;
        const tokenRequest = req.path === '/oauth/token';
        if (authorization || tokenRequest) {
            res.on('finish', () => {
                if (res.statusCode !== 401 && !(tokenRequest && res.statusCode === 400)) {
                    return;
                }
                let username: string | undefined;
                if (tokenRequest) {
                    const body = req.body as { grant_type?: unknown; username?: unknown } | undefined;
                    username = body?.grant_type === 'password' ? String(body.username) : undefined;
                } else if (authorization?.startsWith('Basic ')) {
                    username = Buffer.from(authorization.substring(6), 'base64').toString().split(':')[0];
                }
                const client = `${req.ip} (User-Agent: "${req.headers['user-agent'] || 'unknown'}")`;
                if (username !== undefined) {
                    this.adapter.log.warn(`Rejected the password of "${username}" from ${client}`);
                } else {
                    this.adapter.log.debug(`Rejected credentials from ${client} on ${req.method} ${req.path}`);
                }
            });
        }
        next();
    };

    /**
     * The actual work behind {@link authGuard}: reject unauthenticated requests, and — when OAuth is
     * enabled — additionally reject tokens that were issued for a different resource.
     *
     * @param req The incoming request
     * @param res The response to write to
     * @param next Passed on when the request may proceed
     */
    private async checkAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
        // Only reject a missing credential when authentication is ours to enforce. As a web extension
        // the host decides that — with its authentication off, unauthenticated access is intended.
        if (this.authRequired && !(req as AuthenticatedRequest).user) {
            this.adapter.log.debug(`Rejected unauthenticated MCP request ${req.method} ${req.url} from ${req.ip}`);
            if (!res.headersSent) {
                res.set('WWW-Authenticate', this.buildAuthenticateHeader(req));
                res.status(401).json({
                    jsonrpc: '2.0',
                    error: { code: -32001, message: 'Unauthorized: valid ioBroker credentials required' },
                    id: null,
                });
            }
            return;
        }

        // A token issued for some other service must not be usable here, even when it belongs to a
        // valid ioBroker user — otherwise that service could replay it against us (RFC 8707,
        // "confused deputy"). Tokens without an audience come from the password grant or Basic auth,
        // where no third party was ever involved.
        const authorization = req.headers.authorization;
        if (this.oauthResource && authorization?.startsWith('Bearer ')) {
            const info = await this.getTokenInfo(authorization.substring(7));
            if (info?.aud && !this.isOurAudience(info.aud, req)) {
                this.adapter.log.warn(
                    `Rejected MCP request from ${req.ip}: the access token was issued for "${info.aud}", not for this server`,
                );
                if (!res.headersSent) {
                    res.set(
                        'WWW-Authenticate',
                        this.buildAuthenticateHeader(req, 'invalid_token', 'token was issued for another resource'),
                    );
                    res.status(401).json({
                        jsonrpc: '2.0',
                        error: { code: -32001, message: 'Unauthorized: token was issued for another resource' },
                        id: null,
                    });
                }
                return;
            }
        }

        next();
    }

    /**
     * Read the stored record of an access token.
     *
     * Deliberately goes through the adapter's session storage rather than through an `OAuth2Model`:
     * as a web extension we have no model of our own, but `this.adapter` *is* the host `web` adapter
     * there, so this reads exactly the store its authorization server writes to.
     *
     * @param accessToken The Bearer token presented by the client
     */
    private getTokenInfo(accessToken: string): Promise<ioBroker.Session | null> {
        return new Promise(resolve => this.adapter.getSession(`a:${accessToken}`, data => resolve(data || null)));
    }

    /**
     * Build the `WWW-Authenticate` challenge. With OAuth enabled it carries `resource_metadata`
     * (RFC 9728), which is how an MCP client discovers where to log in — without it, clients cannot
     * start the flow on their own.
     *
     * @param req The incoming request, used to derive the public URL
     * @param error Optional RFC 6750 error code
     * @param description Optional human-readable detail for the error
     */
    private buildAuthenticateHeader(req: Request, error?: string, description?: string): string {
        const params = ['realm="ioBroker MCP"'];
        if (this.oauthResource) {
            params.push(`resource_metadata="${this.getBaseUrl(req)}/.well-known/oauth-protected-resource/mcp"`);
        }
        if (error) {
            params.push(`error="${error}"`);
            if (description) {
                params.push(`error_description="${description}"`);
            }
        }
        return `Bearer ${params.join(', ')}, Basic realm="ioBroker MCP"`;
    }

    /**
     * Whether an access token's audience refers to this MCP endpoint.
     *
     * @param aud The `resource` the token was issued for
     * @param req The incoming request, used to derive the public URL
     */
    private isOurAudience(aud: string, req: Request): boolean {
        const normalize = (uri: string): string => {
            try {
                const parsed = new URL(uri);
                return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
            } catch {
                return uri.replace(/\/+$/, '').toLowerCase();
            }
        };
        const baseUrl = this.getBaseUrl(req);
        const expected = normalize(`${baseUrl}/mcp`);
        const actual = normalize(aud);
        // Accept the bare origin too: some clients send the server root rather than the endpoint path.
        return actual === expected || actual === normalize(baseUrl);
    }

    /**
     * The externally reachable base URL, without a trailing slash. Behind a reverse proxy the
     * request-derived value is wrong, which is what the `publicUrl` setting is for.
     *
     * @param req The incoming request
     */
    private getBaseUrl(req: Request): string {
        if (this.config.publicUrl) {
            return this.config.publicUrl.replace(/\/+$/, '');
        }
        return `${req.protocol}://${req.get('host') || 'localhost'}`;
    }

    /**
     * Called by the ioBroker web adapter to list this extension on its welcome/intro page.
     * Only relevant when running embedded.
     */
    welcomePage(): { link: string; name: string; img: string; color: string; order: number; pro: boolean } {
        return {
            link: WEB_EXTENSION_PREFIX,
            name: 'MCP Server',
            img: 'adapter/mcp/mcp.png',
            color: '#157ac9',
            order: 10,
            pro: false,
        };
    }

    /** Normalize a plain user name or a `system.user.*` id to the full id. */
    private static toUserId(user: string): `system.user.${string}` {
        return (user.startsWith('system.user.') ? user : `system.user.${user}`) as `system.user.${string}`;
    }

    /**
     * The ioBroker user a request runs as: the logged-in user when the request was authenticated (by
     * us or, as a web extension, by the host `web` instance), otherwise the default user.
     */
    private getRequestUser(req: Request): `system.user.${string}` {
        const user = (req as AuthenticatedRequest).user;
        return user ? McpServer.toUserId(user) : this.defaultUser;
    }

    /** The user the current tool call runs as. Outside a request (embedded mode) the default user. */
    private get user(): `system.user.${string}` {
        return this.requestUser.getStore() || this.defaultUser;
    }

    /**
     * Process a request of a session with the permissions of the session's user. The SDK dispatches the
     * contained messages within this call, so every tool reached from here sees that user in {@link user}.
     */
    private runAs(user: `system.user.${string}`, handle: () => Promise<void>): Promise<void> {
        return this.requestUser.run(user, handle);
    }

    /**
     * Get the session of a request. A session is bound to the user that opened it: requests of another
     * user are answered like an unknown session, so that a leaked session id gives no access.
     */
    private getSession(req: Request, res: Response, sessionId: string): SessionContext | undefined {
        const session = this.sessions[sessionId];
        if (session && session.user !== this.getRequestUser(req)) {
            this.adapter.log.warn(
                `Rejected MCP request from ${req.ip}: session ${sessionId} belongs to another user than ${this.getRequestUser(req)}`,
            );
            this.sendSessionNotFound(res, sessionId);
            return undefined;
        }
        if (!session) {
            this.sendSessionNotFound(res, sessionId);
        }
        return session;
    }

    /** Handle client -> server messages (initialize, tools/call, ...). */
    private async handleMcpPost(req: Request, res: Response): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const user = this.getRequestUser(req);
        let transport: StreamableHTTPServerTransport | undefined;

        if (sessionId) {
            transport = this.getSession(req, res, sessionId)?.transport;
            if (!transport) {
                return;
            }
        } else {
            // No session yet: only an "initialize" request may create one.
            if (!isInitializeRequest(req.body)) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                    id: null,
                });
                return;
            }

            const subscriptions = new Set<string>();
            const server = this.createServer(subscriptions, this.getBaseUrl(req));

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid: string) => {
                    this.sessions[sid] = { transport: transport!, server, subscriptions, user };
                    this.adapter.log.debug(`MCP session initialized: ${sid} (user ${user})`);
                },
            });

            transport.onclose = () => {
                const sid = transport!.sessionId;
                if (sid && this.sessions[sid]) {
                    void this.cleanupSession(this.sessions[sid]);
                    delete this.sessions[sid];
                    this.adapter.log.debug(`MCP session closed: ${sid}`);
                }
            };

            await this.hideToolsWithoutRights(server, user);
            await server.connect(transport);
        }

        const sessionTransport = transport;
        await this.runAs(user, () => sessionTransport.handleRequest(req, res, req.body));
    }

    /** Handle server -> client SSE stream (GET) and session termination (DELETE). */
    private async handleMcpSessionRequest(req: Request, res: Response): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }
        const session = this.getSession(req, res, sessionId);
        if (session) {
            await this.runAs(session.user, () => session.transport.handleRequest(req, res));
        }
    }

    /**
     * Answer a request of an unknown session, e.g. after a restart of the adapter or when the session was closed.
     * The Streamable HTTP specification requires 404 here: only then the client starts a new session with
     * "initialize". With 400 the client keeps using the dead session and every further request fails.
     */
    private sendSessionNotFound(res: Response, sessionId: string): void {
        this.adapter.log.debug(`MCP session not found: ${sessionId}`);
        res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
        });
    }

    /**
     * Forward an ioBroker state change to subscribed sessions.
     *
     * Called by our own adapter (standalone) or by the host web adapter (extension mode), which
     * invokes `stateChange` on every web extension that defines it.
     */
    stateChange(id: string, _state: ioBroker.State | null | undefined): void {
        this.notifySubscribers('state', id);
    }

    /**
     * Forward an ioBroker object change to subscribed sessions. Called by our own adapter
     * (standalone) or automatically by the host web adapter (extension mode).
     */
    objectChange(id: string, _obj: ioBroker.Object | null | undefined): void {
        this.notifySubscribers('object', id);
    }

    /** Push `resources/updated` to every session subscribed to the given state/object id. */
    private notifySubscribers(type: 'state' | 'object', id: string): void {
        for (const sid of Object.keys(this.sessions)) {
            const session = this.sessions[sid];
            for (const uri of session.subscriptions) {
                if (uri.startsWith(LOG_URI_PREFIX)) {
                    continue;
                }
                const parsed = iobUriParse(uri);
                if (parsed.type === type && parsed.address === id) {
                    session.server.server.sendResourceUpdated({ uri }).catch(e => {
                        this.adapter.log.debug(`Cannot notify session ${sid} about ${uri}: ${e}`);
                    });
                }
            }
        }
    }

    /** Receive an ioBroker log line: buffer it and push `resources/updated` to ioblog subscribers. */
    private onLog = (message: ioBroker.LogMessage): void => {
        this.logBuffer.push(message);
        if (this.logBuffer.length > LOG_BUFFER_SIZE) {
            this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_SIZE);
        }
        for (const sid of Object.keys(this.sessions)) {
            const session = this.sessions[sid];
            for (const uri of session.subscriptions) {
                if (!uri.startsWith(LOG_URI_PREFIX)) {
                    continue;
                }
                const source = uri.substring(LOG_URI_PREFIX.length) || 'all';
                if (source === 'all' || source === message.from) {
                    session.server.server.sendResourceUpdated({ uri }).catch(e => {
                        this.adapter.log.debug(`Cannot notify session ${sid} about ${uri}: ${e}`);
                    });
                }
            }
        }
    };

    /** Receive the progress of a `cmdExec` started by `install_package` (`cmdStdout`/`cmdStderr`/`cmdExit`). */
    private onMessage = (msg: ioBroker.Message): void => {
        const id = msg?.message?.id;
        const session = typeof id === 'string' ? this.cmdSessions.get(id) : undefined;
        if (!session) {
            // not ours, e.g. a cmdExec of admin or the second (repeated) cmdExit
            return;
        }
        if (msg.command === 'cmdStdout' || msg.command === 'cmdStderr') {
            session.output.push(String(msg.message.data ?? ''));
            if (session.output.length > INSTALL_OUTPUT_LINES) {
                session.output.splice(0, session.output.length - INSTALL_OUTPUT_LINES);
            }
        } else if (msg.command === 'cmdExit') {
            this.cmdSessions.delete(id);
            session.onExit(typeof msg.message.data === 'number' ? msg.message.data : -1);
        }
    };

    /** Classify a resource URI into its subscription kind, address and ref-count key. */
    private uriKind(uri: string): { kind: 'state' | 'object' | 'log' | 'other'; address: string; key: string } {
        if (uri.startsWith(LOG_URI_PREFIX)) {
            return { kind: 'log', address: uri.substring(LOG_URI_PREFIX.length) || 'all', key: 'log' };
        }
        const { type, address } = iobUriParse(uri);
        if (type === 'state' || type === 'object') {
            return { kind: type, address, key: `${type}:${address}` };
        }
        return { kind: 'other', address: '', key: '' };
    }

    /** Add an adapter-level subscription, subscribing on the adapter only on the first reference. */
    private async refSubscribe(uri: string): Promise<void> {
        const { kind, address, key } = this.uriKind(uri);
        if (kind === 'other') {
            return;
        }
        if (!this.subscriptionCounts[key]) {
            this.subscriptionCounts[key] = 0;
            if (kind === 'log') {
                await this.adapter.requireLog?.(true);
            } else if (kind === 'object') {
                await this.adapter.subscribeForeignObjectsAsync(address);
            } else {
                await this.adapter.subscribeForeignStatesAsync(address);
            }
        }
        this.subscriptionCounts[key]++;
    }

    /** Drop an adapter-level subscription, unsubscribing on the adapter when the last reference goes. */
    private async refUnsubscribe(uri: string): Promise<void> {
        const { kind, address, key } = this.uriKind(uri);
        if (kind === 'other' || !this.subscriptionCounts[key]) {
            return;
        }
        this.subscriptionCounts[key]--;
        if (this.subscriptionCounts[key] <= 0) {
            delete this.subscriptionCounts[key];
            if (kind === 'log') {
                await this.adapter.requireLog?.(false);
            } else if (kind === 'object') {
                await this.adapter.unsubscribeForeignObjectsAsync(address);
            } else {
                await this.adapter.unsubscribeForeignStatesAsync(address);
            }
        }
    }

    /** Release all subscriptions held by a session (on close). */
    private async cleanupSession(session: SessionContext): Promise<void> {
        for (const uri of session.subscriptions) {
            await this.refUnsubscribe(uri);
        }
        session.subscriptions.clear();
    }

    /**
     * Remember every tool registered on `server` afterwards (for {@link hideToolsWithoutRights}) and log its
     * calls: a failed call as a warning with the tool and its arguments, a successful call of a writing tool
     * (not `readOnlyHint`) at info level, so the log shows who changed what.
     *
     * @param server the server whose `registerTool` is wrapped
     */
    private trackTools(server: McpSdkServer): void {
        type Handler = (...params: unknown[]) => Promise<ToolResult>;
        const register = server.registerTool.bind(server) as (
            name: string,
            config: unknown,
            handler: Handler,
        ) => RegisteredTool;
        const tools = new Map<string, RegisteredTool>();
        this.registeredTools.set(server, tools);
        (server as unknown as { registerTool: unknown }).registerTool = (
            name: string,
            config: { annotations?: { readOnlyHint?: boolean } },
            handler: Handler,
        ): RegisteredTool => {
            const tool = register(name, config, async (...params) => {
                // Tools with an input schema get (args, extra), the others only (extra)
                const call = `${name}(${McpServer.describeArgs(name, params.length > 1 ? params[0] : undefined)})`;
                let result: ToolResult;
                try {
                    result = await handler(...params);
                } catch (e) {
                    this.adapter.log.warn(
                        `MCP tool error in ${call} by ${this.user}: ${e instanceof Error ? e.message : e}`,
                    );
                    throw e;
                }
                if (result?.isError) {
                    let error = result.content?.[0]?.text;
                    try {
                        error = JSON.parse(error).error ?? error;
                    } catch {
                        // not JSON: log the text as it is
                    }
                    this.adapter.log.warn(`MCP tool error in ${call} by ${this.user}: ${error}`);
                } else if (config?.annotations?.readOnlyHint === false) {
                    this.adapter.log.info(`MCP ${this.user}: ${call}`);
                }
                return result;
            });
            tools.set(name, tool);
            return tool;
        };
    }

    /**
     * The arguments of a tool call for the log: long values are shortened, and contents that may hold secrets
     * or large data (file contents, script code, message payloads) are replaced by their size.
     *
     * @param tool name of the tool
     * @param args arguments of the call
     */
    private static describeArgs(tool: string, args: unknown): string {
        if (!args || typeof args !== 'object') {
            return '';
        }
        const hidden = ['content', 'file_content', ...(LOG_HIDDEN_ARGS[tool] || [])];
        const parts: string[] = [];
        for (const [key, value] of Object.entries(args)) {
            if (value === undefined) {
                continue;
            }
            let text = JSON.stringify(value) ?? String(value);
            if (hidden.includes(key)) {
                text = `<${text.length} chars>`;
            } else if (text.length > LOG_ARG_LENGTH) {
                text = `${text.slice(0, LOG_ARG_LENGTH)}...`;
            }
            parts.push(`${key}=${text}`);
        }
        return parts.join(', ');
    }

    /**
     * Create a new MCP SDK server with all ioBroker tools registered.
     *
     * @param subscriptions the per-session set of subscribed state ids (mutated by subscribe/unsubscribe)
     * @param baseUrl public address of this server, for download/upload links (none in-process)
     */
    private createServer(subscriptions: Set<string>, baseUrl?: string): McpSdkServer {
        const server = new McpSdkServer(
            { name: SERVER_NAME, version: SERVER_VERSION },
            { capabilities: { tools: {}, resources: { subscribe: true } } },
        );
        this.trackTools(server);

        // Logged by trackTools, together with the tool and its arguments
        const fail = (error: unknown): ToolResult => {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
        };
        const canLink = this.linksAvailable && !!baseUrl;
        // A download link for data that is too large for a tool result
        const download = (name: string, data: string | Buffer, contentType: string): Record<string, unknown> => ({
            download_url: this.transferUrl(baseUrl!, this.createTransfer('download', name, data, contentType)),
            expires_in: TRANSFER_TTL / 1000,
        });
        const linkHint = 'fetch it with e.g. `curl -o <file> "<download_url>"` if you can run shell commands';
        // Clients reject results above 1 MiB without telling the server, so never send one
        const ok = (data: unknown): ToolResult => {
            const text = JSON.stringify(data);
            if (wireSize(text) <= MAX_RESULT_BYTES) {
                return { content: [{ type: 'text', text }] };
            }
            const size = `${Math.round(Buffer.byteLength(text) / 1024)} KB`;
            if (canLink) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: true,
                                too_large: true,
                                size,
                                ...download('result.json', text, 'application/json'),
                                hint: `The result (${size}) is too large for one answer: narrow the request down, or ${linkHint}`,
                            }),
                        },
                    ],
                };
            }
            return fail(
                new Error(
                    `The result (${size}) is larger than ${MAX_RESULT_BYTES / 1024} KB, which MCP clients accept. ` +
                        'Narrow the request down (filters, wildcards, time range) or use offset/limit.',
                ),
            );
        };
        // Describe a cut list: how to get the rest, and a link to all of it (if it was cut for its size)
        const pageInfo = <T>(page: Page<T>, all: T[], name: string, link = true): Record<string, unknown> => {
            if (!page.truncated) {
                return {};
            }
            const info: Record<string, unknown> = { truncated: true, total: page.total };
            const ways: string[] = [];
            if (page.nextOffset !== undefined) {
                info.nextOffset = page.nextOffset;
                ways.push('call again with offset=nextOffset');
            }
            ways.push('narrow the request down');
            if (canLink && link) {
                Object.assign(info, download(name, JSON.stringify(all), 'application/json'));
                ways.push(`get all ${all.length} entries from download_url: ${linkHint}`);
            }
            info.hint = `${link ? 'Not everything fits into one answer' : 'There are more entries'}: ${ways.join(', or ')}`;
            return info;
        };
        const offsetSchema = z.number().int().min(0).optional().describe('Skip this many entries (for paging)');
        // Ask the user before a dangerous action, if the client can (MCP elicitation). Clients without
        // elicitation rely on the destructiveHint of the tool instead.
        const confirm = async (message: string): Promise<void> => {
            if (!this.config.confirmDangerous || !server.server.getClientCapabilities()?.elicitation?.form) {
                return;
            }
            // Some clients announce elicitation but cannot show the request and dismiss it on their own
            const noDialog =
                'If no confirmation dialog appeared, the MCP client cannot show confirmation requests (elicitation): ' +
                'turn off "Ask for confirmation before dangerous actions" in the settings of the MCP adapter, ' +
                'or use a client that supports elicitation.';
            let answer: Awaited<ReturnType<typeof server.server.elicitInput>>;
            try {
                answer = await server.server.elicitInput({
                    message,
                    requestedSchema: {
                        type: 'object',
                        properties: { confirm: { type: 'boolean', title: 'Yes, do it' } },
                        required: ['confirm'],
                    },
                });
            } catch (e) {
                throw new Error(
                    `The confirmation request failed: ${e instanceof Error ? e.message : String(e)}. ${noDialog}`,
                );
            }
            this.adapter.log.debug(`Confirmation "${message}" answered with "${answer.action}"`);
            if (answer.action === 'accept' && answer.content?.confirm === true) {
                return;
            }
            if (answer.action === 'cancel') {
                throw new Error(`The confirmation request was dismissed without an answer. ${noDialog}`);
            }
            throw new Error('Cancelled by the user');
        };

        server.registerTool(
            'get_states',
            {
                title: 'Get state values',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Retrieve the current value of one or multiple states. IDs may contain wildcards, ' +
                    'e.g. "hue.0.*.brightness" expands to all matching states. An ID without a state is ' +
                    'returned with exists=false (no such object) or with a hint (the object exists, but ' +
                    'has no value yet or is not a state).',
                inputSchema: {
                    ids: z.array(z.string()).describe('Array of state IDs (wildcards "*" allowed)'),
                    offset: offsetSchema,
                },
            },
            async ({ ids, offset }) => {
                try {
                    const states = await this.getStates(ids);
                    const page = fitItems(states, offset);
                    return ok({ ok: true, data: { states: page.items, ...pageInfo(page, states, 'states.json') } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'wait_for_state',
            {
                title: 'Wait for a state value',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Wait until a state has the given `value` - or, without `value`, until it is updated - and ' +
                    'return the state, e.g. to check that a device really switched or a process finished. ' +
                    `Gives up after \`timeout\` seconds (default ${DEFAULT_WAIT_TIMEOUT}) with reached=false. ` +
                    `The state is read every ${STATE_POLL_INTERVAL} ms, so a value that lasts shorter can be missed.`,
                inputSchema: {
                    id: z.string().describe('State ID'),
                    value: z
                        .any()
                        .optional()
                        .describe('Expected value (coerced to the state type); omit it to wait for the next update'),
                    ack: z
                        .boolean()
                        .optional()
                        .describe(
                            'Only accept a state with this flag: true = confirmed by the device, false = command',
                        ),
                    timeout: z
                        .number()
                        .min(0)
                        .max(MAX_WAIT_TIMEOUT)
                        .optional()
                        .describe(`Seconds to wait at most (default ${DEFAULT_WAIT_TIMEOUT})`),
                },
            },
            async ({ id, value, ack, timeout }, extra) => {
                try {
                    const seconds = timeout ?? DEFAULT_WAIT_TIMEOUT;
                    const obj = await this.adapter.getForeignObjectAsync(id, { user: this.user });
                    const expected = McpServer.coerceValue(value, (obj?.common as AnyCommon | undefined)?.type);
                    const initial = await this.adapter.getForeignStateAsync(id, { user: this.user });
                    const result = await this.waitForState(
                        id,
                        state =>
                            !!state &&
                            (ack === undefined || state.ack === ack) &&
                            (value === undefined
                                ? !initial || state.ts !== initial.ts
                                : McpServer.sameValue(state.val, expected)),
                        seconds,
                        extra.signal,
                    );
                    return ok({
                        ok: true,
                        data: {
                            id,
                            reached: result.reached,
                            state: result.state ?? null,
                            waited_ms: result.waited,
                            ...(result.reached
                                ? {}
                                : {
                                      hint: `${value === undefined ? 'Not updated' : 'The value was not reached'} within ${seconds} s`,
                                  }),
                        },
                    });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'find_orphan_states',
            {
                title: 'Find states without object',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Find states that have no object, e.g. "system.adapter.vis.0.alive" left over from a deleted ' +
                    'instance. The other tools and admin do not show them, but scripts and visualizations may still ' +
                    'read their old values. `pattern` selects the states to check, e.g. "system.adapter.*" or ' +
                    '"hue.0.*"; "*" checks all states and objects, which takes a while on large installations. ' +
                    'Found states can be deleted on the host with `iobroker state del <id>`.',
                inputSchema: {
                    pattern: z
                        .string()
                        .min(1)
                        .describe('IDs of the states to check, wildcards "*" allowed, e.g. "system.adapter.*"'),
                    offset: offsetSchema,
                },
            },
            async ({ pattern, offset }) => {
                try {
                    const { checked, orphans } = await this.findOrphanStates(pattern);
                    const page = fitItems(orphans, offset);
                    return ok({
                        ok: true,
                        data: {
                            pattern,
                            checked,
                            orphans: page.items,
                            ...pageInfo(page, orphans, 'orphans.json'),
                        },
                    });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        if (this.config.allowSetState) {
            server.registerTool(
                'set_state',
                {
                    title: 'Set a state value',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: this.config.setStateDestructive,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Set the value of a state. The value is coerced to the state type (boolean/number/string). ' +
                        'With `wait_ack`, wait until the adapter of the device confirms the command (ack=true) and ' +
                        'return the confirmed state - its value may differ from the written one, e.g. when the ' +
                        'device limits it.',
                    inputSchema: {
                        id: z.string().describe('State ID'),
                        value: z.any().describe('New value (type depends on the state)'),
                        options: z
                            // `.default()` is fine here because it sits inside a nested z.object():
                            // only the top-level fields of an inputSchema are re-wrapped by the SDK
                            // with its own zod copy, which does not recognise a foreign ZodDefault and
                            // then rejects the call with "expected nonoptional". See the top-level
                            // fields of the other tools, which pass their defaults in code instead.
                            .object({ ack: z.boolean().default(false), expire: z.number().int().nullable().optional() })
                            .optional(),
                        wait_ack: z
                            .number()
                            .min(0)
                            .max(MAX_WAIT_TIMEOUT)
                            .optional()
                            .describe(
                                'Wait up to this many seconds for the confirmation (ack=true) by the adapter of the ' +
                                    'device (only for a command, i.e. ack=false)',
                            ),
                    },
                },
                async ({ id, value, options, wait_ack }, extra) => {
                    try {
                        const ack = options?.ack ?? false;
                        const written = await this.setState(id, value, ack);
                        const data: Record<string, unknown> = { id, value: written };
                        if (wait_ack && !ack) {
                            try {
                                // Our command is stored with ack=false, so a state with ack=true is the answer
                                const result = await this.waitForState(
                                    id,
                                    state => !!state?.ack,
                                    wait_ack,
                                    extra.signal,
                                );
                                Object.assign(data, {
                                    acked: result.reached,
                                    state: result.state,
                                    waited_ms: result.waited,
                                    ...(result.reached
                                        ? {}
                                        : {
                                              hint:
                                                  `The value was written, but not confirmed within ${wait_ack} s: the ` +
                                                  'device may be unreachable, or no adapter processes this state',
                                          }),
                                });
                            } catch (e) {
                                data.acked = false;
                                data.ackError = `The value was written, but the confirmation cannot be read: ${e instanceof Error ? e.message : e}`;
                            }
                        }
                        return ok({ ok: true, data });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'set_states',
                {
                    title: 'Set multiple state values',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: this.config.setStateDestructive,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Set multiple states in one call (e.g. for scenes or group actions like "all lights off"). ' +
                        'Each value is coerced to its state type. The call is rejected as a whole and nothing is ' +
                        'written if any of the states may not be written by the configured ioBroker user; other ' +
                        'failures of single states are reported per item and do not abort the rest.',
                    inputSchema: {
                        states: z
                            .array(
                                z.object({
                                    id: z.string().describe('State ID'),
                                    value: z.any().describe('New value (type depends on the state)'),
                                    ack: z.boolean().optional().describe('Acknowledge flag (default false)'),
                                }),
                            )
                            .describe('Array of state/value pairs to write'),
                    },
                },
                async ({ states }) => {
                    try {
                        return ok({ ok: true, data: { results: await this.setStates(states) } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        server.registerTool(
            'get_logs',
            {
                title: 'Read the ioBroker log',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Retrieve recent ioBroker log lines from the host log file. Each entry has {ts, level, ' +
                    'source, message}. Optionally filter by `level` (error/warn/info/debug), by `adapter` ' +
                    '(source, e.g. "hm-rpc.0" or "hm-rpc"), from `from_ts` (ms), or by `search` in the message. ' +
                    'When a filter is set, a larger window of the log is scanned so the matching lines are not ' +
                    'hidden behind debug spam. ' +
                    '`logFile` tells the time of the newest line in the file and its size: if they do not change ' +
                    'between calls, the host does not see new log lines.',
                inputSchema: {
                    level: z.array(z.enum(['error', 'warn', 'info', 'debug'])).optional(),
                    from_ts: z.number().int().optional(),
                    limit: z.number().int().optional().describe('Maximum number of lines to return (default 200)'),
                    adapter: z.string().optional(),
                    search: z
                        .string()
                        .optional()
                        .describe(
                            'Only lines whose message contains this text (case-insensitive), or matches it as a ' +
                                'regular expression when written as /pattern/flags, e.g. "/timeout|ECONNREFUSED/i"',
                        ),
                },
            },
            async args => {
                try {
                    // Keep the newest lines if not all of them fit
                    const { logs, newestTs, fileSize } = await this.getLogs(args);
                    const page = fitItems(logs, 0, true);
                    const logFile: Record<string, unknown> = { newestLineTs: newestTs ?? null, size: fileSize ?? null };
                    if (newestTs !== undefined && Date.now() - newestTs > STALE_LOG_AGE) {
                        logFile.hint =
                            `The newest line of the log file is ${Math.round((Date.now() - newestTs) / 60_000)} ` +
                            'minutes old. If newer messages are expected, the host may still read an old log file ' +
                            '(e.g. the one before the daily rotation).';
                    }
                    return ok({
                        ok: true,
                        data: { logs: page.items, logFile, ...pageInfo(page, logs, 'logs.json') },
                    });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'ping_host',
            {
                title: 'Ping a network host',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
                description:
                    'Check whether a network device is reachable — useful to diagnose adapter connection ' +
                    'errors (e.g. a "connect ETIMEDOUT 192.168.10.5:2001"). Runs an ICMP ping to `host` and, ' +
                    'if `port` is given, also a TCP connect to that port (which tests the actual service, not ' +
                    'just the host). `host` may be an IP or hostname. Returns the overall `reachable` verdict, ' +
                    'ICMP reachability/latency and, when requested, whether the TCP port is open. If the `ping` ' +
                    'command is NOT installed on the ioBroker host, ICMP is skipped (icmp.unavailable=true), ' +
                    'reachability is determined via a TCP fallback instead, and the result carries a `note`/' +
                    '`recommendation` with the exact command to install ping — relay that recommendation to the user.',
                inputSchema: {
                    host: z.string(),
                    port: z.number().int().min(1).max(65535).optional(),
                    count: z.number().int().min(1).max(10).optional().describe('ICMP echo requests (default 2)'),
                    timeout: z.number().int().min(100).max(20000).optional().describe('Timeout in ms (default 2000)'),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: await this.pingHost(args) });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'system_info',
            {
                title: 'System information',
                inputSchema: {},
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'Get system and js-controller information',
            },
            async () => {
                try {
                    return ok({ ok: true, data: await this.getSystemInfo() });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'search_objects',
            {
                title: 'Search objects and states',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Search objects and states by keyword (matched against ID and name) with optional ' +
                    'filters for object type, role, room and source adapter instance',
                inputSchema: {
                    query: z.string().describe('Keyword to search for in object IDs and names'),
                    type: z
                        .string()
                        .optional()
                        .describe('Filter by object type, e.g. state, channel, device, enum, script, instance'),
                    role: z.string().optional(),
                    room: z.string().optional(),
                    adapter: z.string().optional().describe('Filter by source adapter instance, e.g. "hue.0"'),
                    limit: z.number().int().min(1).optional().describe('Maximum number of results (default 50)'),
                    offset: offsetSchema,
                },
            },
            async ({ limit = 50, offset = 0, ...filters }) => {
                try {
                    const matches = await this.searchObjects(filters);
                    const page = fitItems(matches.slice(0, offset + limit), offset);
                    const tooLarge = page.truncated;
                    if (!page.truncated && matches.length > offset + limit) {
                        page.truncated = true;
                        page.nextOffset = offset + limit;
                    }
                    page.total = matches.length;
                    return ok({
                        ok: true,
                        data: { results: page.items, ...pageInfo(page, matches, 'objects.json', tooLarge) },
                    });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_devices',
            {
                title: 'List devices by room',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'List detected devices grouped by room. Uses the ioBroker type-detector to turn ' +
                    'raw states/channels/devices into functional devices with named controls.',
                inputSchema: {
                    language: z
                        .enum(['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'])
                        .optional()
                        .describe('Language for device/room/function names (defaults to the adapter language)'),
                    room: z.string().optional().describe('Filter the result to a single room (by name)'),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: { rooms: await this.listDevices(args) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'history_query',
            {
                title: 'Query the history of a state',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'Query historical values of a state (requires a history adapter)',
                inputSchema: {
                    id: z.string(),
                    from: z.string().optional().describe('Start time (ISO8601)'),
                    to: z.string().optional().describe('End time (ISO8601)'),
                    agg: z
                        .enum([
                            'raw',
                            'min',
                            'max',
                            'avg',
                            'sum',
                            'count',
                            'minmax',
                            'percentile',
                            'quantile',
                            'integral',
                        ])
                        .optional()
                        .describe('Aggregation method (default "raw")'),
                    percentile: z
                        .number()
                        .min(0)
                        .max(100)
                        .optional()
                        .describe('Percentile (0-100), only used with agg=percentile'),
                    quantile: z
                        .number()
                        .min(0)
                        .max(1)
                        .optional()
                        .describe('Quantile (0-1), only used with agg=quantile'),
                    interval: z.string().optional().describe('Aggregation interval, e.g. 15m, 1h'),
                    limit: z.number().int().optional().describe('Maximum number of values (default 1000)'),
                    offset: offsetSchema,
                },
            },
            async ({ offset, ...args }) => {
                try {
                    const result = await this.historyQuery(args);
                    const page = fitItems(result.values, offset);
                    return ok({
                        ok: true,
                        data: { ...result, values: page.items, ...pageInfo(page, result.values, 'history.json') },
                    });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_instances',
            {
                title: 'List adapter instances',
                inputSchema: {},
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'List all adapter instances with their status',
            },
            async () => {
                try {
                    return ok({ ok: true, data: { instances: await this.listInstances() } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_hosts',
            {
                title: 'List ioBroker hosts',
                inputSchema: {},
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'List all ioBroker hosts with their status',
            },
            async () => {
                try {
                    return ok({ ok: true, data: { hosts: await this.listHosts() } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_adapters',
            {
                title: 'List installed adapters',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'List all installed adapters with metadata (version, title, description, keywords). ' +
                    'Unlike list_instances this lists what is installed, not what is running.',
                inputSchema: {
                    language: z
                        .enum(LANGUAGES)
                        .optional()
                        .describe('Language for title/description (defaults to the adapter language)'),
                },
            },
            async ({ language }) => {
                try {
                    return ok({ ok: true, data: { adapters: await this.listAdapters(language) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'search_adapter_repository',
            {
                title: 'Search the adapter repository',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Search the ioBroker adapter REPOSITORY (all installable adapters, not just the ' +
                    'installed ones) by keyword, matched against the adapter name, title, description and ' +
                    'keywords. Use this to recommend which adapter to install for a device or service. ' +
                    'Reads the already-downloaded repository object (fast, no network).',
                inputSchema: {
                    query: z.string().describe('Keyword to search for, e.g. "philips hue", "zigbee", "mqtt"'),
                    type: z
                        .string()
                        .optional()
                        .describe('Filter by adapter category/type, e.g. "lighting", "climate-control", "hardware"'),
                    onlyNotInstalled: z
                        .boolean()
                        .optional()
                        .describe('If true, return only adapters that are not installed yet'),
                    language: z.enum(LANGUAGES).optional().describe('Language for title/description'),
                    limit: z.number().int().optional().describe('Maximum number of results (default 20)'),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: { adapters: await this.searchAdapterRepository(args) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_rooms',
            {
                title: 'List rooms',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'List all rooms (enum.rooms.*) with their members and metadata',
                inputSchema: {
                    language: z
                        .enum(LANGUAGES)
                        .optional()
                        .describe('Language for names (defaults to the adapter language)'),
                    withIcons: z.boolean().optional().describe('Include the icons of the enum and its members'),
                },
            },
            async ({ language, withIcons }) => {
                try {
                    return ok({ ok: true, data: { rooms: await this.readEnums('rooms', language, withIcons) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_functions',
            {
                title: 'List functions',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'List all functions (enum.functions.*) with their members and metadata',
                inputSchema: {
                    language: z
                        .enum(LANGUAGES)
                        .optional()
                        .describe('Language for names (defaults to the adapter language)'),
                    withIcons: z.boolean().optional().describe('Include the icons of the enum and its members'),
                },
            },
            async ({ language, withIcons }) => {
                try {
                    return ok({
                        ok: true,
                        data: { functions: await this.readEnums('functions', language, withIcons) },
                    });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'get_object',
            {
                title: 'Read an object',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'Read a single ioBroker object by its ID',
                inputSchema: { id: z.string().describe('Object ID, e.g. system.adapter.admin.0 or hm-rpc.0.ABC') },
            },
            async ({ id }) => {
                try {
                    const object = await this.adapter.getForeignObjectAsync(id, { user: this.user });
                    return ok({ ok: true, data: { object: object ?? null } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'check_permissions',
            {
                title: 'Check permissions',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Show what the ioBroker user of this MCP session may do: its user and groups, the general ' +
                    'rights of its groups (object/state/file/users/other) and, for the given object IDs, whether ' +
                    'it may read/write/delete the object and read/write the state (by the ACL of the object). ' +
                    'Use it to find out in advance why an action would fail with a permissionError.',
                inputSchema: {
                    ids: z.array(z.string()).max(100).optional().describe('Object IDs to check (no wildcards)'),
                },
            },
            async ({ ids }) => {
                try {
                    return ok({ ok: true, data: await this.checkPermissions(ids || []) });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'read_file',
            {
                title: 'Read a file',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'Read a file from an adapter file storage, e.g. "vis-2.0/main/vis-views.json". ' +
                    `At most \`length\` bytes (default ${DEFAULT_MAX_READ_BYTES}) are returned per call; ` +
                    'large files are read in chunks: when the result has `truncated: true`, call again with ' +
                    '`offset` set to the returned `nextOffset` until `truncated` is false. ' +
                    '`size` is the total file size in bytes. If you can run shell commands (e.g. Claude Code), ' +
                    'set `download: true` instead to get a link to the whole file, which you fetch with curl.',
                inputSchema: {
                    path: z.string().describe('Path as "<adapter>/<dir>/<file>"'),
                    base64: z.boolean().optional().describe('Return binary content base64-encoded'),
                    offset: z
                        .number()
                        .int()
                        .min(0)
                        .optional()
                        .describe('Byte offset to start reading from (default 0)'),
                    length: z
                        .number()
                        .int()
                        .min(1)
                        .optional()
                        .describe(`Maximum number of bytes to return (default ${DEFAULT_MAX_READ_BYTES})`),
                    download: z
                        .boolean()
                        .optional()
                        .describe('Return a download link to the whole file instead of its content'),
                },
            },
            async ({ path, base64, offset, length, download: asLink }) => {
                try {
                    if (asLink) {
                        if (!canLink) {
                            throw new Error(this.linksUnavailableReason || 'Links are not available');
                        }
                        const { adapterName, fileName } = McpServer.parseFilePath(path);
                        const file = await this.adapter.readFileAsync(adapterName, fileName, {
                            user: this.user,
                        });
                        const data = Buffer.isBuffer(file.file) ? file.file : Buffer.from(file.file || '');
                        const mimeType = file.mimeType || 'application/octet-stream';
                        return ok({
                            ok: true,
                            data: {
                                path,
                                size: data.length,
                                mimeType,
                                ...download(fileName.split('/').pop() || 'file', data, mimeType),
                                hint: linkHint,
                            },
                        });
                    }
                    return ok({ ok: true, data: await this.readFile(path, base64, offset, length) });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_files',
            {
                title: 'List a directory',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'List a directory in an adapter file storage, e.g. "vis-2.0/main" or "0_userdata.0"',
                inputSchema: { path: z.string().describe('Path as "<adapter>[/<dir>]"'), offset: offsetSchema },
            },
            async ({ path, offset }) => {
                try {
                    const files = await this.listFiles(path);
                    const page = fitItems(files, offset);
                    return ok({ ok: true, data: { path, files: page.items, ...pageInfo(page, files, 'files.json') } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'file_exists',
            {
                title: 'Check whether a file exists',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'Check whether a file exists in an adapter file storage',
                inputSchema: { path: z.string().describe('Path as "<adapter>/<dir>/<file>"') },
            },
            async ({ path }) => {
                try {
                    const { adapterName, fileName } = McpServer.parseFilePath(path);
                    const exists = await this.adapter.fileExistsAsync(adapterName, fileName, {
                        user: this.user,
                    });
                    return ok({ ok: true, data: { path, exists: !!exists } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        // Always-on log writing (does not change states or objects).
        server.registerTool(
            'write_log',
            {
                title: 'Write a log message',
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: false,
                },
                description: 'Write a message to the ioBroker log',
                inputSchema: {
                    message: z.string(),
                    level: z.enum(['error', 'warn', 'info', 'debug']).optional().describe('Log level (default "info")'),
                },
            },
            ({ message, level }): Promise<ToolResult> => {
                try {
                    const logLevel = level || 'info';
                    this.adapter.log[logLevel](message);
                    return Promise.resolve(ok({ ok: true, data: { message, level: logLevel } }));
                } catch (e) {
                    return Promise.resolve(fail(e));
                }
            },
        );

        // Object/file changes are gated behind the "allowObjectChange" option (off by default).
        if (this.config.allowObjectChange) {
            server.registerTool(
                'set_object',
                {
                    title: 'Create or update an object',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Create or update an ioBroker object. An existing object is updated by merging the ' +
                        'provided common/native; a missing one is created from the provided object.',
                    inputSchema: {
                        id: z.string().describe('Object ID'),
                        // Deliberately `looseObject` and not `record`: the MCP SDK converts the tool
                        // schemas with the zod copy of its own dependency tree, which is not
                        // necessarily the one these schemas were built with. `record`'s JSON Schema
                        // processor relies on a context field that only newer zod versions create,
                        // so a split zod installation makes `tools/list` throw -32603 and the client
                        // ends up with no tools at all. `looseObject` produces the same
                        // `additionalProperties` schema and works across versions.
                        obj: z
                            .looseObject({})
                            .describe('Partial object, e.g. { "type": "state", "common": {...}, "native": {...} }'),
                    },
                },
                async ({ id, obj }) => {
                    try {
                        const result = await this.setObject(id, obj);
                        return ok({ ok: true, data: result });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'delete_object',
                {
                    title: 'Delete an object',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Delete an ioBroker object (and optionally all its children). ' +
                        'Be careful: deleting objects that were not created by the user can break adapters.',
                    inputSchema: {
                        id: z.string().describe('Object ID'),
                        recursive: z.boolean().optional().describe('Also delete all child objects'),
                    },
                },
                async ({ id, recursive }) => {
                    try {
                        await confirm(`Delete the object "${id}"${recursive ? ' and all its children' : ''}?`);
                        await this.deleteObject(id, recursive);
                        return ok({ ok: true, data: { id, deleted: true } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'create_state',
                {
                    title: 'Create a state',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: false,
                    },
                    description:
                        'Create a new state object (e.g. under "0_userdata.0."). Fails if the object already ' +
                        'exists - use set_object to modify existing objects.',
                    inputSchema: {
                        id: z.string().describe('Full state ID, e.g. "0_userdata.0.myState"'),
                        name: z.string().optional().describe('Display name (defaults to the last ID segment)'),
                        type: z
                            .enum(['boolean', 'number', 'string', 'array', 'object', 'mixed'])
                            .optional()
                            .describe('Value type of the state (default "mixed")'),
                        role: z
                            .string()
                            .optional()
                            .describe('Role, e.g. switch.light, value.temperature (default "state")'),
                        read: z.boolean().optional().describe('Readable (default true)'),
                        write: z.boolean().optional().describe('Writable (default true)'),
                        unit: z.string().optional(),
                        min: z.number().optional(),
                        max: z.number().optional(),
                        step: z.number().optional(),
                        def: z.any().optional().describe('Initial value (written with ack=true)'),
                        desc: z.string().optional().describe('Description'),
                    },
                },
                async args => {
                    try {
                        return ok({ ok: true, data: await this.createState(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'create_scene',
                {
                    title: 'Create or update a scene',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Create or update a scene for the ioBroker "scenes" adapter: a named collection of ' +
                        'state/value pairs applied together (e.g. "movie night" dims lights and closes blinds). ' +
                        'Activate the scene by setting its state to true. Requires an installed scene instance.',
                    inputSchema: {
                        name: z.string().describe('Scene name, becomes part of the ID (e.g. "movie_night")'),
                        members: z
                            .array(
                                z.object({
                                    id: z.string().describe('State ID to set'),
                                    value: z.any().describe('Value applied when the scene is activated'),
                                }),
                            )
                            .describe('State/value pairs that define the scene'),
                        instance: z.string().optional().describe('Scene adapter instance (default "scene.0")'),
                        description: z.string().optional(),
                    },
                },
                async args => {
                    try {
                        return ok({ ok: true, data: await this.createScene(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'create_alias',
                {
                    title: 'Create an alias',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: false,
                    },
                    description:
                        'Create an alias state (alias.0.*) that points to another state, e.g. to give a device a ' +
                        'stable, readable id that survives replacing the hardware. Type, role, unit and limits are ' +
                        'copied from the target. With write_target, reading and writing use different states ' +
                        '(e.g. a thermostat with separate actual and set values). Fails if the alias exists.',
                    inputSchema: {
                        id: z.string().describe('Alias id, e.g. "livingroom.ceiling_light" (becomes alias.0.…)'),
                        target: z.string().describe('State the alias reads (and writes), e.g. "hue.0.light.state"'),
                        write_target: z.string().optional().describe('Different state for writing'),
                        name: z.string().optional().describe('Display name (default: name of the target)'),
                        role: z.string().optional().describe('Role (default: role of the target)'),
                        unit: z.string().optional().describe('Unit (default: unit of the target)'),
                    },
                },
                async args => {
                    try {
                        return ok({ ok: true, data: await this.createAlias(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'write_file',
                {
                    title: 'Write a file',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Write a file to an adapter file storage, e.g. "vis-2.0/main/vis-views.json". Give the ' +
                        'content, or - for a large file, if you can run shell commands - upload it with ' +
                        'prepare_upload and give its upload_id.',
                    inputSchema: {
                        path: z.string().describe('Path as "<adapter>/<dir>/<file>"'),
                        content: z.string().optional().describe('File content (UTF-8, or base64 when base64=true)'),
                        base64: z.boolean().optional().describe('Treat content as base64-encoded binary'),
                        upload_id: z.string().optional().describe('Id of a file uploaded via prepare_upload'),
                    },
                },
                async ({ path, content, base64, upload_id }) => {
                    try {
                        if ((content === undefined) === (upload_id === undefined)) {
                            throw new Error('Give either "content" or "upload_id"');
                        }
                        if (upload_id !== undefined) {
                            const upload = this.getUpload(upload_id);
                            const { adapterName, fileName } = McpServer.parseFilePath(path);
                            await this.adapter.writeFileAsync(adapterName, fileName, fs.readFileSync(upload.file), {
                                user: this.user,
                            });
                            this.removeTransfer(upload_id);
                            return ok({ ok: true, data: { path, size: upload.size } });
                        }
                        await this.writeFile(path, content!, base64);
                        return ok({ ok: true, data: { path } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'delete_file',
                {
                    title: 'Delete a file',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description: 'Delete a file from an adapter file storage',
                    inputSchema: { path: z.string().describe('Path as "<adapter>/<dir>/<file>"') },
                },
                async ({ path }) => {
                    try {
                        const { adapterName, fileName } = McpServer.parseFilePath(path);
                        await this.adapter.delFileAsync(adapterName, fileName, { user: this.user });
                        return ok({ ok: true, data: { path, deleted: true } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'rename_file',
                {
                    title: 'Rename or move a file',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: false,
                        openWorldHint: false,
                    },
                    description:
                        'Rename or move a file/directory within the same adapter file storage, ' +
                        'e.g. "vis-2.0/main/a.json" -> "vis-2.0/backup/a.json"',
                    inputSchema: {
                        path: z.string().describe('Current path as "<adapter>/<dir>/<file>"'),
                        new_path: z.string().describe('New path as "<adapter>/<dir>/<file>" (same adapter)'),
                    },
                },
                async ({ path, new_path }) => {
                    try {
                        await this.renameFile(path, new_path);
                        return ok({ ok: true, data: { path: new_path } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'mkdir',
                {
                    title: 'Create a directory',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description: 'Create a directory in an adapter file storage, e.g. "0_userdata.0/my-folder"',
                    inputSchema: { path: z.string().describe('Path as "<adapter>/<dir>"') },
                },
                async ({ path }) => {
                    try {
                        const { adapterName, dirName } = McpServer.parseDirPath(path);
                        if (!dirName) {
                            throw new Error(
                                'Path must contain a directory after the adapter, e.g. "0_userdata.0/my-folder"',
                            );
                        }
                        await this.adapter.mkdirAsync(adapterName, dirName, { user: this.user });
                        return ok({ ok: true, data: { path } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        server.registerTool(
            'list_adapter_updates',
            {
                title: 'List adapter updates',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'List the installed adapters that have a newer version in the active repository ' +
                    '(installed and available version). Reads the already-downloaded repository (no network).',
                inputSchema: {},
            },
            async () => {
                try {
                    return ok({ ok: true, data: { updates: await this.listAdapterUpdates() } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_notifications',
            {
                title: 'List system notifications',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'List the current system notifications of the hosts, as shown by the bell in ioBroker.admin ' +
                    '(e.g. disk space low, adapter crashed repeatedly, adapter updates). Each entry has host, ' +
                    'scope, category, severity, the affected instance and its messages.',
                inputSchema: {
                    host: z.string().optional().describe('Only this host (default: all running hosts)'),
                    language: z.enum(LANGUAGES).optional().describe('Language for names and descriptions'),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: { notifications: await this.listNotifications(args) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_scripts',
            {
                title: 'List scripts',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description:
                    'List the scripts of the javascript adapter (JavaScript, TypeScript, Blockly, Rules) with ' +
                    'id, name, type, whether they run, and the javascript instance - without the source.',
                inputSchema: {
                    folder: z.string().optional().describe('Only scripts in this folder, e.g. "common" or "lights"'),
                    offset: offsetSchema,
                },
            },
            async ({ folder, offset }) => {
                try {
                    const scripts = await this.listScripts(folder);
                    const page = fitItems(scripts, offset);
                    return ok({
                        ok: true,
                        data: { scripts: page.items, ...pageInfo(page, scripts, 'scripts.json') },
                    });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'get_script',
            {
                title: 'Read a script',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                description: 'Read a script of the javascript adapter including its source code',
                inputSchema: {
                    id: z.string().describe('Script id, e.g. "script.js.common.lights" or "common.lights"'),
                },
            },
            async ({ id }) => {
                try {
                    const script = await this.getScriptObject(id);
                    return ok({ ok: true, data: this.scriptInfo(script.id, script.obj, true) });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        if (this.config.allowSetState) {
            server.registerTool(
                'clear_notifications',
                {
                    title: 'Acknowledge notifications',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Acknowledge (delete) system notifications of a host - all, or only those of one scope, ' +
                        'category and/or instance as returned by list_notifications.',
                    inputSchema: {
                        host: z.string().optional().describe('Host (default: the host of this instance)'),
                        scope: z.string().optional().describe('e.g. "system"'),
                        category: z.string().optional().describe('e.g. "diskSpaceIssues"'),
                        instance: z.string().optional().describe('e.g. "hue.0"'),
                    },
                },
                async args => {
                    try {
                        return ok({ ok: true, data: await this.clearNotifications(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        if (this.config.allowInstanceControl) {
            const instanceSchema = { id: z.string().describe('Instance, e.g. "hue.0"') };
            server.registerTool(
                'start_instance',
                {
                    title: 'Start an instance',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description: 'Start (enable) an adapter instance',
                    inputSchema: instanceSchema,
                },
                async ({ id }) => {
                    try {
                        return ok({ ok: true, data: await this.setInstanceEnabled(id, true) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'stop_instance',
                {
                    title: 'Stop an instance',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Stop (disable) an adapter instance. It stays stopped until it is started again, also ' +
                        'after a restart of ioBroker.',
                    inputSchema: instanceSchema,
                },
                async ({ id }) => {
                    try {
                        await confirm(`Stop the instance "${id}"?`);
                        return ok({ ok: true, data: await this.setInstanceEnabled(id, false) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'restart_instance',
                {
                    title: 'Restart an instance',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: false,
                    },
                    description: 'Restart a running adapter instance, e.g. after changing its configuration',
                    inputSchema: instanceSchema,
                },
                async ({ id }) => {
                    try {
                        return ok({ ok: true, data: await this.restartInstance(id) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'set_log_level',
                {
                    title: 'Set the log level of an instance',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Change the log level of an adapter instance, e.g. to "debug" to analyze a problem with ' +
                        'get_logs. By default only until the next start of the instance and without a restart; ' +
                        'with persistent=true it is stored in the instance configuration (restarts the instance).',
                    inputSchema: {
                        id: z.string().describe('Instance, e.g. "hue.0"'),
                        level: z.enum(['silly', 'debug', 'info', 'warn', 'error']),
                        persistent: z.boolean().optional().describe('Store it permanently (default false)'),
                    },
                },
                async ({ id, level, persistent }) => {
                    try {
                        return ok({ ok: true, data: await this.setLogLevel(id, level, persistent) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        if (this.config.allowAdapterManagement) {
            const timeoutSchema = z
                .number()
                .int()
                .min(1)
                .max(3600)
                .optional()
                .describe(
                    `Seconds to wait (default ${DEFAULT_INSTALL_TIMEOUT}); the command keeps running on the host after that`,
                );

            server.registerTool(
                'add_instance',
                {
                    title: 'Add an adapter instance',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: true,
                    },
                    description:
                        'Create a new instance of an adapter from the repository (`iobroker add`). Installs the ' +
                        'adapter first if it is not installed yet. Find adapters with search_adapter_repository.',
                    inputSchema: {
                        adapter: z.string().describe('Adapter name, e.g. "hue"'),
                        instance: z.number().int().min(0).optional().describe('Instance number (default: next free)'),
                        host: z.string().optional().describe('Host (default: the host of this instance)'),
                        timeout: timeoutSchema,
                    },
                },
                async args => {
                    try {
                        return ok({ ok: true, data: await this.addInstance(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'delete_instance',
                {
                    title: 'Delete an adapter instance',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: false,
                        openWorldHint: false,
                    },
                    description:
                        'Delete an adapter instance with its configuration, objects and states (`iobroker del`). ' +
                        'This cannot be undone.',
                    inputSchema: {
                        id: z.string().describe('Instance, e.g. "hue.0"'),
                        timeout: timeoutSchema,
                    },
                },
                async args => {
                    try {
                        // Before asking: the user should not confirm what is denied anyway
                        await this.assertOtherPermission('execute', 'run commands on a host');
                        await confirm(
                            `Delete the instance "${args.id}" with its configuration, objects and states? This cannot be undone.`,
                        );
                        return ok({ ok: true, data: await this.deleteInstance(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'upgrade_adapter',
                {
                    title: 'Upgrade an adapter',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: true,
                    },
                    description:
                        'Upgrade an installed adapter to the version of the active repository or to the given ' +
                        'version (`iobroker upgrade`). Its instances are restarted. See list_adapter_updates.',
                    inputSchema: {
                        adapter: z.string().describe('Adapter name, e.g. "hue"'),
                        version: z.string().optional().describe('Version (default: the repository version)'),
                        host: z.string().optional().describe('Host (default: the host of this instance)'),
                        timeout: timeoutSchema,
                    },
                },
                async args => {
                    try {
                        await this.assertOtherPermission('execute', 'run commands on a host');
                        await confirm(
                            `Upgrade the adapter "${args.adapter}"${args.version ? ` to ${args.version}` : ''}?`,
                        );
                        return ok({ ok: true, data: await this.upgradeAdapter(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        // Large files cannot pass through the model: the client uploads them with a separate program
        if (canLink && (this.config.allowObjectChange || this.config.allowPackageInstall)) {
            server.registerTool(
                'prepare_upload',
                {
                    title: 'Prepare a file upload',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: false,
                    },
                    description:
                        'Get a one-time link to upload a file that is too large for a tool argument, e.g. a .tgz ' +
                        'for install_package or a big file for write_file. Only useful if you can run shell ' +
                        'commands (e.g. Claude Code): upload the local file with `curl -T <file> "<url>"`, then ' +
                        `pass the returned upload_id to install_package or write_file. Valid for ${TRANSFER_TTL / 60_000} minutes, ` +
                        `up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
                    inputSchema: {
                        name: z.string().describe('File name, e.g. "iobroker.hue-3.9.1.tgz"'),
                    },
                },
                ({ name }) => {
                    try {
                        const token = this.createTransfer('upload', name);
                        const url = this.transferUrl(baseUrl, token);
                        return Promise.resolve(
                            ok({
                                ok: true,
                                data: {
                                    upload_id: token,
                                    url,
                                    method: 'PUT',
                                    expires_in: TRANSFER_TTL / 1000,
                                    command: `curl -T "${name}" "${url}"`,
                                },
                            }),
                        );
                    } catch (e) {
                        return Promise.resolve(fail(e));
                    }
                },
            );
        }

        // Installing packages runs arbitrary code on the host, so it is a separate opt-in for developers.
        if (this.config.allowPackageInstall) {
            server.registerTool(
                'install_package',
                {
                    title: 'Install an adapter package',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: false,
                        openWorldHint: true,
                    },
                    description:
                        'Developer tool: install an ioBroker adapter package on a host, like "Install from custom ' +
                        'URL" / "file" in ioBroker.admin (`iobroker url`). Give exactly one of: `source` - an npm ' +
                        'package ("iobroker.hue@3.9.0" or just "hue"), a GitHub repository ' +
                        '("ioBroker/ioBroker.hue#main" or https URL), an https URL of a .tgz or a .tgz path on the ' +
                        'target host; `file_path` - a .tgz in the ioBroker file storage ("0_userdata.0/x.tgz"); or ' +
                        '`file_name` + `file_content` - a small .tgz as base64; or `upload_id` - a .tgz uploaded ' +
                        'via prepare_upload (for large files, if you can run shell commands). Waits until the installation is ' +
                        'finished (or `timeout`), returns the exit code and the last output lines. Enabled instances ' +
                        'of the adapter are restarted afterwards; no new instance is created. `instances` tells for ' +
                        'each restarted instance whether it came up again (alive) within `start_timeout` and its ' +
                        'first log lines since the restart.',
                    inputSchema: {
                        source: z
                            .string()
                            .optional()
                            .describe('npm package, GitHub repository, https URL or path of a .tgz on the host'),
                        file_path: z
                            .string()
                            .optional()
                            .describe('.tgz in the ioBroker file storage as "<adapter>/<dir>/<file>.tgz"'),
                        file_name: z
                            .string()
                            .optional()
                            .describe('File name of the .tgz in file_content, e.g. "iobroker.hue-3.9.0.tgz"'),
                        file_content: z.string().optional().describe('The .tgz file as base64'),
                        upload_id: z.string().optional().describe('Id of a .tgz uploaded via prepare_upload'),
                        host: z.string().optional().describe('Target host (default: the host of this instance)'),
                        debug: z.boolean().optional().describe('Install with --debug for more output'),
                        restart_instances: z
                            .boolean()
                            .optional()
                            .describe('Restart enabled instances of the adapter after installing (default true)'),
                        start_timeout: z
                            .number()
                            .int()
                            .min(0)
                            .max(300)
                            .optional()
                            .describe(
                                `Seconds to wait for the restarted instances to come up (default ${DEFAULT_START_TIMEOUT}, 0 = do not wait)`,
                            ),
                        timeout: z
                            .number()
                            .int()
                            .min(1)
                            .max(3600)
                            .optional()
                            .describe(
                                `Seconds to wait for the installation (default ${DEFAULT_INSTALL_TIMEOUT}); it keeps running on the host after that`,
                            ),
                    },
                },
                async args => {
                    try {
                        await this.assertOtherPermission('execute', 'run commands on a host');
                        await confirm(
                            `Install the package "${args.source || args.file_path || args.file_name || args.upload_id}"? It runs with full rights on the host.`,
                        );
                        return ok({ ok: true, data: await this.installPackage(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        if (this.config.allowScriptChange) {
            const engineTypeSchema = z
                .enum(['Javascript/js', 'TypeScript/ts'])
                .optional()
                .describe('Script language (default "Javascript/js")');

            server.registerTool(
                'set_script',
                {
                    title: 'Create or change a script',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description:
                        'Create a JavaScript/TypeScript script of the javascript adapter or replace the source of ' +
                        'an existing one (a running script restarts with the new source). New scripts are created ' +
                        'disabled unless enabled=true; missing folders are created. Blockly and Rules scripts ' +
                        'cannot be changed. Test code first with run_script.',
                    inputSchema: {
                        id: z.string().describe('Script id, e.g. "common.lights" (folder "common") or "lights"'),
                        source: z.string().describe('The complete source code'),
                        engineType: engineTypeSchema,
                        name: z.string().optional().describe('Display name (default: last part of the id)'),
                        enabled: z.boolean().optional().describe('Start (true) or stop (false) the script'),
                        instance: z.string().optional().describe('javascript instance (default "javascript.0")'),
                    },
                },
                async args => {
                    try {
                        await confirm(`Save the script "${args.id}"${args.enabled ? ' and start it' : ''}?`);
                        return ok({ ok: true, data: await this.setScript(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'enable_script',
                {
                    title: 'Start or stop a script',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description: 'Start (enabled=true) or stop (enabled=false) a script of the javascript adapter',
                    inputSchema: {
                        id: z.string().describe('Script id, e.g. "script.js.common.lights"'),
                        enabled: z.boolean(),
                    },
                },
                async ({ id, enabled }) => {
                    try {
                        return ok({ ok: true, data: await this.enableScript(id, enabled) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'delete_script',
                {
                    title: 'Delete a script',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: true,
                        openWorldHint: false,
                    },
                    description: 'Delete a script of the javascript adapter',
                    inputSchema: { id: z.string().describe('Script id, e.g. "script.js.common.lights"') },
                },
                async ({ id }) => {
                    try {
                        await confirm(`Delete the script "${id}"?`);
                        return ok({ ok: true, data: await this.deleteScript(id) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'run_script',
                {
                    title: 'Run code once',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: false,
                        openWorldHint: false,
                    },
                    description:
                        'Run JavaScript/TypeScript once in the javascript adapter, with the same API as a script ' +
                        '(getState, setState, log, ...), and return everything it logged. Nothing is stored; ' +
                        'timers and subscriptions end after `timeout`. Use it to test code before set_script. ' +
                        'Requires javascript adapter 10.1.0 or newer.',
                    inputSchema: {
                        source: z.string().describe('The code, e.g. log(getState("hue.0.light.state").val)'),
                        engineType: engineTypeSchema,
                        timeout: z
                            .number()
                            .int()
                            .min(0)
                            .max(60000)
                            .optional()
                            .describe('Milliseconds to collect asynchronous output (default 5000)'),
                        instance: z.string().optional().describe('javascript instance (default "javascript.0")'),
                    },
                },
                async args => {
                    try {
                        await this.assertOtherPermission('sendto', 'send messages to adapters');
                        await confirm('Run the code in the javascript adapter?');
                        return ok({ ok: true, data: await this.runScript(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        if (this.config.sendToAllowlist) {
            server.registerTool(
                'send_to',
                {
                    title: 'Send a message to an adapter',
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: true,
                        idempotentHint: false,
                        openWorldHint: true,
                    },
                    description:
                        'Send a message to an adapter instance (`sendTo`) and return its answer, e.g. a Telegram ' +
                        'message ({instance:"telegram.0", command:"send", message:{text:"Hi"}}) or a backup ' +
                        `(backitup.0, "oneClick"). Allowed instances: ${this.config.sendToAllowlist}. The commands ` +
                        'and the message format are described in the documentation of each adapter.',
                    inputSchema: {
                        instance: z.string().describe('Instance, e.g. "telegram.0"'),
                        command: z.string().describe('Command, e.g. "send"'),
                        message: z.any().optional().describe('Message payload (object or string)'),
                        timeout: z
                            .number()
                            .int()
                            .min(100)
                            .max(120000)
                            .optional()
                            .describe('Milliseconds to wait for the answer (default 10000)'),
                    },
                },
                async args => {
                    try {
                        await this.assertOtherPermission('sendto', 'send messages to adapters');
                        await confirm(`Send "${args.command}" to "${args.instance}"?`);
                        return ok({ ok: true, data: await this.sendToInstance(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        // --- Prompts: ready-made workflows that MCP clients offer as slash commands ---
        server.registerPrompt(
            'diagnose_adapter',
            {
                title: 'Diagnose an adapter',
                description: 'Find out why an adapter instance does not work and suggest a fix',
                argsSchema: { instance: z.string().describe('Instance, e.g. "hue.0"') },
            },
            ({ instance }) => ({
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text:
                                `Diagnose the ioBroker instance "${instance}". Check with list_instances whether it ` +
                                `is enabled, alive and connected, read its errors and warnings with get_logs ` +
                                `(adapter "${instance}"), look at list_notifications and, if the log names a device ` +
                                `or service address, test it with ping_host. Compare its version with ` +
                                `list_adapter_updates. Explain the cause in plain words and suggest the fix; ask ` +
                                `before you change anything.`,
                        },
                    },
                ],
            }),
        );

        server.registerPrompt(
            'room_overview',
            {
                title: 'Room overview',
                description: 'Summarize the devices of a room and their current state',
                argsSchema: { room: z.string().describe('Room name, e.g. "Living room"') },
            },
            ({ room }) => ({
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text:
                                `Give me an overview of the room "${room}" in ioBroker: use list_devices for the ` +
                                `room and get_states for the current values. Group them into lights, climate, ` +
                                `windows/doors and others and point out anything unusual (open windows, lights on, ` +
                                `low batteries, unreachable devices).`,
                        },
                    },
                ],
            }),
        );

        server.registerPrompt(
            'create_automation',
            {
                title: 'Create an automation',
                description: 'Turn a description into an ioBroker script',
                argsSchema: { description: z.string().describe('What should happen, e.g. "lights off at 23:00"') },
            },
            ({ description }) => ({
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text:
                                `Create an ioBroker automation: ${description}\n` +
                                `Find the state ids with list_devices and search_objects, check the existing scripts ` +
                                `with list_scripts and write a JavaScript for the javascript adapter (on(), ` +
                                `schedule(), setState()). Test parts with run_script if available, show me the code ` +
                                `and save it with set_script only after I agreed. If the script tools are not ` +
                                `available, show me the code so I can paste it into the script editor.`,
                        },
                    },
                ],
            }),
        );

        // --- Resources: expose states and objects via the canonical ioBroker URI scheme ---
        // States as `iobstate://<id>`, objects as `iobobject://<id>`. On change the server pushes a
        // `notifications/resources/updated` over the session's SSE stream and the client re-reads.
        server.registerResource(
            'state',
            new ResourceTemplate('iobstate://{id}', { list: undefined }),
            {
                title: 'ioBroker state',
                description: 'A single ioBroker state value, addressed as iobstate://<id>',
                mimeType: 'application/json',
            },
            async (uri, variables) => {
                const id = decodeURIComponent(String(variables.id));
                const state = await this.adapter.getForeignStateAsync(id, { user: this.user });
                const body = state
                    ? { id, val: state.val, ack: state.ack, ts: state.ts, lc: state.lc, q: state.q }
                    : { id, val: null };
                return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }] };
            },
        );

        server.registerResource(
            'object',
            new ResourceTemplate('iobobject://{id}', { list: undefined }),
            {
                title: 'ioBroker object',
                description: 'A single ioBroker object, addressed as iobobject://<id>',
                mimeType: 'application/json',
            },
            async (uri, variables) => {
                const id = decodeURIComponent(String(variables.id));
                const obj = await this.adapter.getForeignObjectAsync(id, { user: this.user });
                return {
                    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(obj ?? null) }],
                };
            },
        );

        // Log stream: `ioblog://all` for every source, or `ioblog://<source>` (e.g. ioblog://admin.0).
        // Subscribe to receive `resources/updated` on each new log line, then re-read for recent lines.
        server.registerResource(
            'log',
            new ResourceTemplate(`${LOG_URI_PREFIX}{source}`, { list: undefined }),
            {
                title: 'ioBroker log stream',
                description: 'Recent log lines, addressed as ioblog://all or ioblog://<source>',
                mimeType: 'application/json',
            },
            (uri, variables) => {
                const source = decodeURIComponent(String(variables.source)) || 'all';
                const logs = this.logBuffer
                    .filter(m => source === 'all' || m.from === source)
                    .map(m => ({ ts: m.ts, level: m.severity, source: m.from, message: m.message }));
                return Promise.resolve({
                    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ source, logs }) }],
                });
            },
        );

        // Manual subscribe/unsubscribe handlers (the high-level McpServer does not provide them).
        // Subscriptions are stored as the full canonical URI; supported for states and objects.
        server.server.setRequestHandler(SubscribeRequestSchema, async request => {
            const uri = request.params.uri;
            if (this.uriKind(uri).kind !== 'other' && !subscriptions.has(uri)) {
                subscriptions.add(uri);
                await this.refSubscribe(uri);
            }
            return {};
        });
        server.server.setRequestHandler(UnsubscribeRequestSchema, async request => {
            const uri = request.params.uri;
            if (subscriptions.has(uri)) {
                subscriptions.delete(uri);
                await this.refUnsubscribe(uri);
            }
            return {};
        });

        return server;
    }

    // ---------------------------------------------------------------------
    // Tool implementations (return plain data; the wrappers serialize them)
    // ---------------------------------------------------------------------

    /** Build the result entry for one state. */
    private static stateEntry(id: string, state: ioBroker.State): Record<string, unknown> {
        const entry: Record<string, unknown> = { id, value: state.val, ack: state.ack, ts: state.ts };
        if (state.lc !== state.ts) {
            entry.lc = state.lc;
        }
        return entry;
    }

    private async getStates(ids: string[]): Promise<Record<string, unknown>[]> {
        const states: Record<string, unknown>[] = [];
        for (const id of ids) {
            try {
                if (id.includes('*')) {
                    // Wildcard pattern: expand to all matching states.
                    const matches = await this.adapter.getForeignStatesAsync(id, { user: this.user });
                    for (const [matchId, state] of Object.entries(matches || {})) {
                        if (state) {
                            states.push(McpServer.stateEntry(matchId, state));
                        }
                    }
                } else {
                    const state = await this.adapter.getForeignStateAsync(id, { user: this.user });
                    states.push(state ? McpServer.stateEntry(id, state) : await this.missingStateEntry(id));
                }
            } catch (e) {
                states.push({ id, value: null, error: e instanceof Error ? e.message : String(e) });
            }
        }
        return states;
    }

    /** Build the result entry for an ID without a state: tell a missing object from a state without a value. */
    private async missingStateEntry(id: string): Promise<Record<string, unknown>> {
        const obj = await this.adapter.getForeignObjectAsync(id, { user: this.user });
        if (!obj) {
            return { id, value: null, exists: false };
        }
        return {
            id,
            value: null,
            exists: true,
            hint:
                obj.type === 'state'
                    ? 'The object exists, but the state has no value yet'
                    : `"${id}" is a ${obj.type} object, not a state`,
        };
    }

    /**
     * Write multiple states as one operation: the write permission of every state is verified first, so a
     * batch containing a single state the user may not write fails as a whole and nothing is
     * written. Other failures of single states are reported per item and do not abort the rest.
     */
    private async setStates(
        items: { id: string; value: unknown; ack?: boolean }[],
    ): Promise<Record<string, unknown>[]> {
        await this.assertStatesWritable(items.map(item => item.id));
        const results: Record<string, unknown>[] = [];
        for (const item of items) {
            try {
                const written = await this.setState(item.id, item.value, item.ack ?? false);
                results.push({ id: item.id, value: written });
            } catch (e) {
                results.push({ id: item.id, error: e instanceof Error ? e.message : String(e) });
            }
        }
        return results;
    }

    /**
     * Verify a right of the "other" category of the user, like admin does for `cmdExec` (`execute`) and
     * `sendTo` (`sendto`). js-controller does not check them for messages, so without this an MCP user
     * could run what the ioBroker user may not.
     *
     * @param operation `execute` for CLI commands on a host, `sendto` for messages to adapters
     * @param action what was denied, for the error message (e.g. `run "iobroker url ..." on host "x"`)
     * @throws {Error} a permissionError before anything was done
     */
    private async assertOtherPermission(operation: 'execute' | 'sendto', action: string): Promise<void> {
        if (this.user === 'system.user.admin') {
            return;
        }
        const permissions = await this.adapter.calculatePermissionsAsync(this.user, []);
        if (permissions.groups?.includes('system.group.administrator') || permissions.other?.[operation]) {
            return;
        }
        throw new Error(
            `permissionError: user "${this.user}" may not ${action} (missing "${operation}" in the ` +
                '"other" permissions of its groups) - nothing was done',
        );
    }

    /**
     * Verify that the user of the request may write every given state, mirroring the checks js-controller runs in
     * `setForeignState`: the user must be able to read the object (needed for the type coercion in
     * {@link setState}) and the state ACL must allow writing — for an alias also on its write target.
     *
     * @param ids state IDs to check
     * @throws {Error} when at least one state may not be written; the message lists all of them
     */
    private async assertStatesWritable(ids: string[]): Promise<void> {
        if (this.user === 'system.user.admin') {
            return;
        }
        const permissions = await this.adapter.calculatePermissionsAsync(this.user, []);
        if (permissions.groups?.includes('system.group.administrator')) {
            return;
        }
        const denied: string[] = [];
        for (const id of new Set(ids)) {
            let obj: ioBroker.Object | null | undefined;
            try {
                obj = await this.adapter.getForeignObjectAsync(id, { user: this.user });
            } catch {
                denied.push(id);
                continue;
            }
            let writable = this.isStateWritable(obj, permissions);
            const alias = (obj?.common as { alias?: { id?: string | { read?: string; write?: string } } } | undefined)
                ?.alias;
            const targetId = typeof alias?.id === 'object' ? alias.id.write : alias?.id;
            if (writable && id.startsWith('alias.') && targetId) {
                // js-controller checks the target with the rights of the adapter itself, not the object read
                writable = this.isStateWritable(await this.adapter.getForeignObjectAsync(targetId), permissions);
            }
            if (!writable) {
                denied.push(id);
            }
        }
        if (denied.length) {
            throw new Error(
                `permissionError: user "${this.user}" may not write ${denied.join(', ')} - nothing was written`,
            );
        }
    }

    /**
     * The state ACL check of js-controller for `setState` on a single object.
     *
     * @param obj the state object (objects without ACL are not restricted by js-controller)
     * @param permissions the merged group permissions of the user
     */
    private isStateWritable(obj: ioBroker.Object | null | undefined, permissions: ioBroker.PermissionSet): boolean {
        const acl = obj?.acl as Partial<ioBroker.StateACL> | undefined;
        const stateAcl = acl?.state || acl?.object;
        if (!acl || !stateAcl) {
            return true;
        }
        return !!permissions.state?.write && this.aclGrants(acl, stateAcl, ACL_WRITE, permissions);
    }

    /**
     * The ACL bit check of js-controller: the owner, owner-group or everyone bits of `bits`, depending on
     * who the user of the request is.
     *
     * @param acl the ACL of the object (owner and owner group)
     * @param bits the `object` or `state` bits of the ACL
     * @param flag {@link ACL_READ} or {@link ACL_WRITE} (as the "everyone" bit)
     * @param permissions the merged group permissions of the user
     */
    private aclGrants(
        acl: Partial<ioBroker.StateACL>,
        bits: number,
        flag: number,
        permissions: ioBroker.PermissionSet,
    ): boolean {
        if (acl.owner === this.user) {
            return !!(bits & (flag << 8));
        }
        if (acl.ownerGroup && permissions.groups?.includes(acl.ownerGroup)) {
            return !!(bits & (flag << 4));
        }
        return !!(bits & flag);
    }

    /**
     * What the user of the request may do: the general rights of its groups and, per object, the result of
     * the ACL checks js-controller runs for reading, writing and deleting the object and its state.
     *
     * @param ids object IDs to check
     */
    private async checkPermissions(ids: string[]): Promise<Record<string, unknown>> {
        const permissions = await this.adapter.calculatePermissionsAsync(this.user, []);
        const admin = this.user === 'system.user.admin' || !!permissions.groups?.includes('system.group.administrator');
        const rights = {
            object: permissions.object,
            state: permissions.state,
            file: permissions.file,
            users: permissions.users,
            other: permissions.other,
        };
        const objects: Record<string, unknown>[] = [];
        for (const id of ids) {
            // Read with the rights of the adapter: the ACL of objects the user may not read is needed as well
            const obj = await this.adapter.getForeignObjectAsync(id);
            if (!obj) {
                objects.push({ id, exists: false });
                continue;
            }
            const acl = obj.acl as Partial<ioBroker.StateACL> | undefined;
            const allowed = (general: boolean | undefined, bits: number | undefined, flag: number): boolean =>
                admin || (!!general && (!acl || bits === undefined || this.aclGrants(acl, bits, flag, permissions)));
            const entry: Record<string, unknown> = {
                id,
                exists: true,
                type: obj.type,
                object: {
                    read: allowed(permissions.object?.read, acl?.object, ACL_READ),
                    write: allowed(permissions.object?.write, acl?.object, ACL_WRITE),
                    delete: allowed(permissions.object?.delete, acl?.object, ACL_WRITE),
                },
            };
            if (obj.type === 'state') {
                const stateBits = acl?.state ?? acl?.object;
                entry.state = {
                    read: allowed(permissions.state?.read, stateBits, ACL_READ),
                    write: allowed(permissions.state?.write, stateBits, ACL_WRITE),
                };
            }
            if (acl && (admin || (entry.object as { read: boolean }).read)) {
                entry.acl = { owner: acl.owner, ownerGroup: acl.ownerGroup, object: acl.object, state: acl.state };
            }
            objects.push(entry);
        }
        return {
            user: this.user,
            groups: permissions.groups || [],
            admin,
            rights,
            ...(ids.length ? { objects } : {}),
        };
    }

    /**
     * Parse the raw log-file lines returned by the host `getLogs` into structured entries.
     *
     * The host replies with an array of raw strings (the file size is appended as the last, numeric
     * element). Lines carry ANSI color codes and look like
     * `2026-06-12 11:46:39.802  - error: hm-rpc.0 (1234) Init not possible…`. This mirrors the admin
     * `LogsWorker` parsing: strip the color codes, then split timestamp / level / rest, and treat lines
     * without a leading timestamp as continuations (e.g. stack traces) of the previous entry.
     */
    private parseLogLines(rawLines: unknown[]): { ts: number; level: string; source: string; message: string }[] {
        const entries: { ts: number; level: string; source: string; message: string }[] = [];
        for (const raw of rawLines) {
            if (typeof raw !== 'string') {
                continue;
            }
            // Also strip the trailing CR: the host splits the CRLF log file on \n only, leaving a \r
            // that would otherwise break the `$` anchor of the line regex below.
            const clean = raw.replace(/\x1b\[\d+m/g, '').replace(/\r$/, ''); // eslint-disable-line no-control-regex
            const match = clean.match(
                /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+-\s+(silly|debug|info|warn|error):\s*(.*)$/,
            );
            if (match) {
                const rest = match[3];
                const fromMatch = rest.match(/^(host\.[^\s]+|[-\w]+\.\d+)/);
                entries.push({
                    ts: new Date(match[1].replace(' ', 'T')).getTime(),
                    level: match[2],
                    source: fromMatch ? fromMatch[1] : '',
                    message: rest,
                });
            } else if (entries.length && clean.trim() && !/^\d+$/.test(clean.trim())) {
                // Continuation line (e.g. a stack trace). The trailing file-size element is a bare number,
                // which the `\d+` guard skips.
                entries[entries.length - 1].message += `\n${clean}`;
            }
        }
        return entries;
    }

    /**
     * Read the tail of the host log file and filter it.
     *
     * @returns the matching lines plus the time of the newest line in the read window and the file size, so a
     *          log file that is no longer written (e.g. the host still reads the one before a rotation) shows
     */
    private getLogs(params: {
        level?: string[];
        from_ts?: number;
        limit?: number;
        adapter?: string;
        search?: string;
    }): Promise<{ logs: Record<string, unknown>[]; newestTs?: number; fileSize?: number }> {
        const limit = Math.max(1, params.limit || 200);
        // `search` is a text (case-insensitive) or a regular expression written as /pattern/flags
        let matches: ((message: string) => boolean) | undefined;
        if (params.search) {
            const regExp = params.search.match(/^\/(.+)\/([a-z]*)$/);
            if (regExp) {
                let pattern: RegExp;
                try {
                    // without g/y: test() would continue from the last match
                    pattern = new RegExp(regExp[1], regExp[2].replace(/[gy]/g, ''));
                } catch (e) {
                    return Promise.reject(
                        new Error(`Invalid regular expression ${params.search}: ${e instanceof Error ? e.message : e}`),
                    );
                }
                matches = message => pattern.test(message);
            } else {
                const text = params.search.toLowerCase();
                matches = message => message.toLowerCase().includes(text);
            }
        }
        const filtering = !!(
            (params.level && params.level.length) ||
            params.adapter ||
            params.from_ts !== undefined ||
            matches
        );
        // The host `getLogs` returns the tail of the log file (≈150 bytes per requested line). When a
        // filter is active, scan a much larger window so error/warn lines are not pushed out by a flood
        // of debug lines from a chatty adapter.
        const fetchLines = filtering ? Math.min(Math.max(limit * 10, 3000), 20000) : limit;

        return new Promise((resolve, reject) => {
            // The controller expects the line count as the plain message (a number) and replies with an
            // ARRAY of raw string lines — NOT an object with a `list` property.
            this.adapter.sendToHost(this.adapter.host || null, 'getLogs', fetchLines, (result: any) => {
                const rawList: unknown = Array.isArray(result) ? result : result?.list;
                if (!Array.isArray(rawList)) {
                    if (result && result.error) {
                        reject(new Error(result.error));
                    } else {
                        resolve({ logs: [] });
                    }
                    return;
                }
                let logs = this.parseLogLines(rawList);
                const newestTs = logs.length ? logs[logs.length - 1].ts : undefined;
                // The host appends the size of the log file as the last element: as a string after reading
                // the file, as a number only if reading failed
                const last = rawList[rawList.length - 1];
                const fileSize =
                    typeof last === 'number'
                        ? last
                        : typeof last === 'string' && /^\d+$/.test(last)
                          ? Number(last)
                          : undefined;
                if (params.level && params.level.length) {
                    logs = logs.filter(log => params.level!.includes(log.level));
                }
                if (params.from_ts !== undefined) {
                    logs = logs.filter(log => log.ts >= params.from_ts!);
                }
                if (params.adapter) {
                    const adapter = params.adapter;
                    logs = logs.filter(log => log.source === adapter || log.source.startsWith(`${adapter}.`));
                }
                if (matches) {
                    logs = logs.filter(log => matches(log.message));
                }
                // Return the most recent `limit` matching lines.
                if (logs.length > limit) {
                    logs = logs.slice(logs.length - limit);
                }
                resolve({
                    logs: logs.map(log => ({
                        ts: log.ts,
                        level: log.level,
                        source: log.source,
                        message: log.message,
                        host: this.adapter.host,
                    })),
                    newestTs,
                    fileSize,
                });
            });
        });
    }

    /**
     * Diagnose whether a network device/service is reachable: an ICMP ping to `host` and, if `port`
     * is given, a TCP connect to that port. Used to investigate adapter connection errors.
     */
    private async pingHost(params: {
        host: string;
        port?: number;
        count?: number;
        timeout?: number;
    }): Promise<Record<string, unknown>> {
        const host = (params.host || '').trim();
        // Only allow plausible IP/hostname characters — and never a leading "-" — so the value can't be
        // injected as an option to the `ping` executable.
        if (!host || host.startsWith('-') || !/^[a-zA-Z0-9._:-]+$/.test(host)) {
            throw new Error(`Invalid host: ${params.host}`);
        }
        const count = Math.min(Math.max(params.count || 2, 1), 10);
        const timeout = Math.min(Math.max(params.timeout || 2000, 100), 20000);

        this.adapter.log.debug(
            `[ping_host] request host="${host}" port=${params.port ?? '-'} count=${count} timeout=${timeout}ms platform=${process.platform}`,
        );

        const resolvedIp = await new Promise<string | undefined>(resolve =>
            dns.lookup(host, (err, address) => resolve(err ? undefined : address)),
        );
        this.adapter.log.debug(`[ping_host] dns.lookup("${host}") -> ${resolvedIp ?? '(no resolution)'}`);

        const icmp = await this.icmpPing(host, count, timeout);
        const result: Record<string, unknown> = {
            host,
            ...(resolvedIp && resolvedIp !== host ? { resolved_ip: resolvedIp } : {}),
            icmp,
        };

        if (params.port !== undefined) {
            // Explicit port requested -> probe exactly that one.
            result.tcp = await this.tcpProbe(host, params.port, timeout);
        } else if (!icmp.reachable) {
            // ICMP did not confirm reachability — either the `ping` binary is missing (e.g. not installed
            // in the container) or ICMP is blocked/filtered by a firewall. Fall back to TCP connects on
            // common ports so a host that simply ignores ping (very common for routers) isn't wrongly
            // reported as "down".
            const tcpFallback = await this.tcpReachable(host, timeout);
            result.tcp_fallback = tcpFallback;
        }

        // Overall verdict: reachable if ICMP answered OR a TCP fallback port accepted the connection.
        const fb = result.tcp_fallback as { reachable?: boolean } | undefined;
        result.reachable = !!icmp.reachable || !!fb?.reachable;
        // If ICMP could not be used because `ping` is not installed, surface the recommendation at the
        // top level so the assistant relays it to the user (and the verdict is based on TCP only).
        if (icmp.unavailable && typeof icmp.recommendation === 'string') {
            result.method = 'tcp';
            result.note = icmp.recommendation;
        }
        this.adapter.log.debug(`[ping_host] result: ${JSON.stringify(result)}`);
        return result;
    }

    /** ICMP ping via the OS `ping` command (no elevated privileges needed). */
    private icmpPing(host: string, count: number, timeout: number): Promise<Record<string, unknown>> {
        const isWin = process.platform === 'win32';
        const bin = this.resolvePingBinary();
        // Windows: -n count, -w timeout(ms per reply). Unix: -c count, -W timeout(s per reply).
        const args = isWin
            ? ['-n', String(count), '-w', String(timeout), host]
            : ['-c', String(count), '-W', String(Math.max(1, Math.round(timeout / 1000))), host];
        this.adapter.log.debug(`[ping_host] icmp exec: ${bin} ${args.join(' ')}`);
        return new Promise(resolve => {
            execFile(bin, args, { timeout: timeout * count + 3000, windowsHide: true }, (err, stdout, stderr) => {
                const out = `${stdout || ''}${stderr || ''}`;
                const errCode = err ? `${(err as NodeJS.ErrnoException).code ?? err.message}` : 'none';
                this.adapter.log.debug(`[ping_host] icmp exitError=${errCode} raw output:\n${out}`);
                // ENOENT = the `ping` executable was not found at all. That is NOT "host unreachable";
                // report it explicitly so the caller can rely on the TCP fallback instead.
                if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
                    const install = this.suggestPingInstall();
                    this.adapter.log.warn(
                        `[ping_host] "ping" executable not found. ICMP check skipped — using TCP fallback. To enable ICMP, install it: ${install.command}`,
                    );
                    resolve({
                        reachable: false,
                        unavailable: true,
                        error: 'ping executable not found on this host',
                        recommendation: `ICMP ping is not available because the "ping" command is not installed on the ioBroker host. Reachability was therefore determined via TCP. To enable real ICMP ping, install it on the host (${install.os}): ${install.command}`,
                        install_command: install.command,
                    });
                    return;
                }
                // Number of received replies (Windows "Received = N", Unix "N received").
                const received = isWin
                    ? Number(out.match(/Received = (\d+)/)?.[1] ?? out.match(/Empfangen = (\d+)/)?.[1] ?? 0)
                    : Number(out.match(/(\d+) (?:packets )?received/)?.[1] ?? 0);
                // Average round-trip time, if reported.
                const avg = isWin
                    ? (out.match(/Average = (\d+)ms/)?.[1] ?? out.match(/Mittelwert = (\d+)ms/)?.[1])
                    : out.match(/=\s*[\d.]+\/([\d.]+)\//)?.[1];
                this.adapter.log.debug(
                    `[ping_host] icmp parsed: received=${received} (matchedWin=${isWin}) avg=${avg ?? '-'} -> reachable=${received > 0}`,
                );
                resolve({
                    reachable: received > 0,
                    sent: count,
                    received,
                    ...(avg ? { avg_ms: Math.round(parseFloat(avg)) } : {}),
                });
            });
        });
    }

    /**
     * Locate the `ping` executable. On Linux the adapter process sometimes runs with a minimal `PATH`
     * (e.g. only `/usr/bin`) while `ping` lives in `/bin` or `/sbin`, which makes a bare `ping` fail with
     * ENOENT. Probe the common absolute locations and fall back to the bare name otherwise.
     */
    private resolvePingBinary(): string {
        if (process.platform === 'win32') {
            return 'ping';
        }
        for (const candidate of ['/bin/ping', '/usr/bin/ping', '/sbin/ping', '/usr/sbin/ping']) {
            try {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            } catch {
                // ignore and try the next candidate
            }
        }
        return 'ping';
    }

    /**
     * Build a distro-appropriate command to install the `ping` tool, used in the recommendation when the
     * binary is missing. The distro is detected from the package manager / release files present on disk.
     */
    private suggestPingInstall(): { os: string; command: string } {
        if (process.platform === 'win32') {
            return { os: 'Windows', command: 'ping is part of Windows — no installation needed' };
        }
        if (process.platform === 'darwin') {
            return { os: 'macOS', command: 'ping is part of macOS — no installation needed' };
        }
        const exists = (p: string): boolean => {
            try {
                return fs.existsSync(p);
            } catch {
                return false;
            }
        };
        if (exists('/etc/alpine-release') || exists('/sbin/apk')) {
            // Common on the official ioBroker Docker image (Alpine based).
            return { os: 'Alpine Linux', command: 'apk add --no-cache iputils-ping' };
        }
        if (exists('/etc/debian_version') || exists('/usr/bin/apt-get')) {
            return { os: 'Debian/Ubuntu', command: 'sudo apt-get update && sudo apt-get install -y iputils-ping' };
        }
        if (exists('/usr/bin/dnf')) {
            return { os: 'Fedora/RHEL', command: 'sudo dnf install -y iputils' };
        }
        if (exists('/usr/bin/yum')) {
            return { os: 'CentOS/RHEL', command: 'sudo yum install -y iputils' };
        }
        if (exists('/etc/arch-release') || exists('/usr/bin/pacman')) {
            return { os: 'Arch Linux', command: 'sudo pacman -S --noconfirm iputils' };
        }
        return { os: 'Linux', command: 'install the "iputils-ping" (or "iputils") package via your package manager' };
    }

    /**
     * Reachability fallback when ICMP is unavailable/blocked: try a TCP connect to a handful of ports
     * that are commonly open on routers/devices. The host counts as reachable as soon as one port either
     * accepts the connection or actively refuses it (a RST also proves the host is up).
     */
    private async tcpReachable(host: string, timeout: number): Promise<Record<string, unknown>> {
        const ports = [80, 443, 53, 22, 7547, 8080];
        const perPort = Math.min(Math.max(Math.round(timeout / 2), 500), 3000);
        this.adapter.log.debug(`[ping_host] tcp fallback on ports ${ports.join(',')} (perPort=${perPort}ms)`);
        for (const port of ports) {
            const probe = await this.tcpProbe(host, port, perPort);
            // "open" = accepted; a "connection refused" error proves the host is alive but the port closed.
            const refused = typeof probe.error === 'string' && /refused|ECONNREFUSED/i.test(probe.error);
            if (probe.open || refused) {
                return { reachable: true, port, open: !!probe.open, refused, latency_ms: probe.latency_ms };
            }
        }
        return { reachable: false, tried_ports: ports };
    }

    /** TCP connect probe — tests whether a specific service port accepts connections. */
    private tcpProbe(host: string, port: number, timeout: number): Promise<Record<string, unknown>> {
        this.adapter.log.debug(`[ping_host] tcp connect ${host}:${port} (timeout=${timeout}ms)`);
        return new Promise(resolve => {
            const start = Date.now();
            const socket = new net.Socket();
            let settled = false;
            const done = (open: boolean, error?: string): void => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                const probe = { port, open, latency_ms: Date.now() - start, ...(error ? { error } : {}) };
                this.adapter.log.debug(`[ping_host] tcp result: ${JSON.stringify(probe)}`);
                resolve(probe);
            };
            socket.setTimeout(timeout);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false, 'timeout'));
            socket.once('error', (e: Error) => done(false, e.message));
            socket.connect(port, host);
        });
    }

    private async getSystemInfo(): Promise<Record<string, unknown>> {
        const hostObj = await this.adapter.getForeignObjectAsync(`system.host.${this.adapter.host}`, {
            user: this.user,
        });
        const jsControllerVersion = hostObj?.common?.installedVersion || 'unknown';
        const totalMem = Math.round(os.totalmem() / (1024 * 1024));
        const freeMem = Math.round(os.freemem() / (1024 * 1024));
        const instanceObjs = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance', {
            user: this.user,
        });

        return {
            js_controller: jsControllerVersion,
            hostname: os.hostname(),
            platform: os.platform(),
            node: process.version.substring(1),
            cpu_load: parseFloat((os.loadavg()[0] || 0).toFixed(2)),
            mem: { total_mb: totalMem, used_mb: totalMem - freeMem },
            uptime_sec: Math.round(os.uptime()),
            instances: Object.keys(instanceObjs || {}).length,
        };
    }

    private async searchObjects(params: {
        query?: string;
        type?: string;
        role?: string;
        room?: string;
        adapter?: string;
    }): Promise<Record<string, unknown>[]> {
        const { query = '', type, role, room, adapter } = params;
        const result = await this.adapter.getObjectListAsync(
            {
                startkey: '',
                endkey: '\u9999',
            },
            { sorted: true, user: this.user },
        );
        const allObjects = result.rows;
        const roomMembers = room ? await this.getEnumMembers('enum.rooms.', room) : null;
        const needle = query.toLowerCase();

        const results: Record<string, unknown>[] = [];
        for (const obj of allObjects) {
            const o = obj.value;
            const name = this.getName(o?.common?.name);
            if (needle && !obj.value._id.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) {
                continue;
            }
            if (type && o?.type !== type) {
                continue;
            }
            if (role && o?.common?.role !== role) {
                continue;
            }
            if (roomMembers && !roomMembers.includes(obj.value._id)) {
                continue;
            }
            const sourceAdapter = obj.value._id.match(/^([^.]+\.\d+)/)?.[1] || '';
            if (adapter && sourceAdapter !== adapter) {
                continue;
            }
            results.push({
                id: obj.value._id,
                type: o?.type || 'state',
                role: o?.common?.role || '',
                name,
                adapter: sourceAdapter,
            });
        }
        return results;
    }

    private async listDevices(params: { language?: ioBroker.Languages; room?: string }): Promise<Room[]> {
        const lang = params.language || this.language;
        const rooms = await getAiFriendlyStructure(this.adapter, lang, { user: this.user });
        if (params.room) {
            const needle = params.room.toLowerCase();
            return rooms.filter(r => r.roomName.toLowerCase() === needle);
        }
        return rooms;
    }

    private async historyQuery(params: {
        id: string;
        from?: string;
        to?: string;
        agg?: string;
        percentile?: number;
        quantile?: number;
        interval?: string;
        limit?: number;
    }): Promise<{ id: string; values: unknown[] } & Record<string, unknown>> {
        const options: ioBroker.GetHistoryOptions = {
            aggregate: AGG_MAP[params.agg || 'raw'] || 'none',
            count: params.limit ?? 1000,
            limit: params.limit ?? 1000,
        };
        if (params.from) {
            options.start = new Date(params.from).getTime();
        }
        if (params.to) {
            options.end = new Date(params.to).getTime();
        }
        if (params.percentile !== undefined) {
            (options as Record<string, unknown>).percentile = params.percentile;
        }
        if (params.quantile !== undefined) {
            (options as Record<string, unknown>).quantile = params.quantile;
        }
        const step = params.interval ? this.parseInterval(params.interval) : undefined;
        if (step) {
            options.step = step;
        }
        // GetHistoryOptions has no typed `user` field, but the controller honors it for ACL checks.
        (options as Record<string, unknown>).user = this.user;

        const res = await this.adapter.getHistoryAsync(params.id, options);
        return { id: params.id, values: res?.result || [] };
    }

    private async listInstances(): Promise<Record<string, unknown>[]> {
        const objs = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance', {
            user: this.user,
        });
        const result: Record<string, unknown>[] = [];
        for (const [fullId, obj] of Object.entries(objs || {})) {
            const id = fullId.replace('system.adapter.', '');
            const aliveState = await this.adapter.getForeignStateAsync(`${fullId}.alive`, { user: this.user });
            const connState = await this.adapter.getForeignStateAsync(`${fullId}.connected`, {
                user: this.user,
            });
            result.push({
                id,
                enabled: !!obj?.common?.enabled,
                alive: !!aliveState?.val,
                connected: connState ? !!connState.val : null,
                version: obj?.common?.version || '',
                title: this.getName(obj?.common?.titleLang || obj?.common?.title),
            });
        }
        return result;
    }

    /** List installed adapters (system.adapter.<name> objects, no instances). */
    private async listAdapters(language?: ioBroker.Languages): Promise<Record<string, unknown>[]> {
        const lang = language || this.language;
        const view = await this.adapter.getObjectViewAsync(
            'system',
            'adapter',
            { startkey: 'system.adapter.', endkey: 'system.adapter.香' },
            { user: this.user },
        );
        return view.rows.map(row => {
            const common = (row.value?.common || {}) as Record<string, any>;
            return {
                name: common.name || row.id.replace('system.adapter.', ''),
                version: common.version || '',
                title: getText(common.titleLang || common.title, lang),
                description: getText(common.desc, lang),
                keywords: common.keywords || [],
                mode: common.mode || '',
            };
        });
    }

    /**
     * Search the adapter repository (all installable adapters) by keyword. Reads the already-downloaded
     * repository object `system.repositories` — fast, no network — and matches against name, title,
     * description and keywords, with an optional category `type` filter and an `installed` flag.
     */
    private async searchAdapterRepository(params: {
        query?: string;
        type?: string;
        onlyNotInstalled?: boolean;
        language?: ioBroker.Languages;
        limit?: number;
    }): Promise<Record<string, unknown>[]> {
        const lang = params.language || this.language;
        const needle = (params.query || '').toLowerCase();
        const limit = params.limit ?? 20;

        const json = await this.getRepositoryJson();
        if (!Object.keys(json).length) {
            return [];
        }

        // Determine which adapters are already installed.
        const installedView = await this.adapter.getObjectViewAsync(
            'system',
            'adapter',
            { startkey: 'system.adapter.', endkey: 'system.adapter.香' },
            { user: this.user },
        );
        const installed = new Set(
            installedView.rows.map(row => row.value?.common?.name || row.id.replace('system.adapter.', '')),
        );

        const results: Record<string, unknown>[] = [];
        for (const [name, entry] of Object.entries(json)) {
            if (name.startsWith('_')) {
                continue; // skip _repoInfo and similar meta keys
            }
            const e = entry as Record<string, any>;
            const title = getText(e.titleLang || e.title, lang);
            const desc = getText(e.desc, lang);
            const keywords: string[] = Array.isArray(e.keywords) ? e.keywords : [];
            const type = (e.type as string) || '';

            if (params.type && type !== params.type) {
                continue;
            }
            const isInstalled = installed.has(name);
            if (params.onlyNotInstalled && isInstalled) {
                continue;
            }
            if (needle && !`${name} ${title} ${desc} ${keywords.join(' ')}`.toLowerCase().includes(needle)) {
                continue;
            }
            results.push({
                name,
                title,
                description: desc,
                keywords,
                type,
                version: (e.version as string) || '',
                installed: isInstalled,
            });
            if (results.length >= limit) {
                break;
            }
        }
        return results;
    }

    private async listHosts(): Promise<Record<string, unknown>[]> {
        const objs = await this.adapter.getForeignObjectsAsync('system.host.*', 'host', { user: this.user });
        const result: Record<string, unknown>[] = [];
        for (const [fullId, obj] of Object.entries(objs || {})) {
            const aliveState = await this.adapter.getForeignStateAsync(`${fullId}.alive`, { user: this.user });
            result.push({
                id: fullId.replace('system.host.', ''),
                alive: !!aliveState?.val,
                js_controller: obj?.common?.installedVersion || '',
                platform: obj?.native?.os?.platform || '',
            });
        }
        return result;
    }

    /**
     * Read the rooms/functions enums with localized names and details about each member object
     * (ported from the ioBroker n8n node's `readIobEnums`).
     */
    private async readEnums(
        type: 'rooms' | 'functions',
        language?: ioBroker.Languages,
        withIcons?: boolean,
    ): Promise<EnumResponse[]> {
        const enums = await this.adapter.getObjectViewAsync(
            'system',
            'enum',
            { startkey: `enum.${type}.`, endkey: `enum.${type}.香` },
            { user: this.user },
        );

        const result: EnumResponse[] = [];
        // Cache member objects so a member shared by several enums is read only once.
        const cache: Record<string, ioBroker.Object | null | false> = {};

        for (const row of enums.rows) {
            const enumObj = row.value;
            const common = (enumObj.common || {}) as AnyCommon;
            const oneEnum: EnumResponse = {
                id: enumObj._id,
                name: (language ? getText(common.name, language) : common.name) || enumObj._id.split('.').pop() || '',
                color: common.color,
                icon: withIcons ? common.icon : undefined,
                items: [],
            };
            result.push(oneEnum);

            for (const member of common.members || []) {
                let obj = cache[member];
                if (obj === undefined) {
                    try {
                        cache[member] =
                            (await this.adapter.getForeignObjectAsync(member, { user: this.user })) || false;
                    } catch {
                        cache[member] = false;
                    }
                    obj = cache[member];
                }
                if (obj) {
                    const c = (obj.common || {}) as AnyCommon;
                    oneEnum.items.push({
                        id: member,
                        type: obj.type,
                        name: (language ? getText(c.name, language) : c.name) || member.split('.').pop() || '',
                        color: c.color,
                        icon: withIcons ? c.icon : undefined,
                        stateType: c.type,
                        min: c.min,
                        max: c.max,
                        unit: c.unit,
                        role: c.role,
                        step: c.step,
                    });
                }
            }
        }
        return result;
    }

    /** Write a state, coercing the value to the state's declared type (boolean/number/string). */
    private async setState(id: string, value: unknown, ack: boolean): Promise<ioBroker.StateValue> {
        const obj = await this.adapter.getForeignObjectAsync(id, { user: this.user });
        const stateType = (obj?.common as AnyCommon | undefined)?.type;
        const coerced = McpServer.coerceValue(value, stateType);
        await this.adapter.setForeignStateAsync(id, coerced, ack, { user: this.user });
        return coerced;
    }

    /**
     * Read a state until `reached` accepts it, the time is up or the client cancels the call.
     *
     * @param id state ID
     * @param reached the condition
     * @param timeoutSeconds how long to wait at most
     * @param signal aborted when the client cancels the call
     * @returns whether the condition was met, the last read state and how long it took (ms)
     */
    private async waitForState(
        id: string,
        reached: (state: ioBroker.State | null | undefined) => boolean,
        timeoutSeconds: number,
        signal?: AbortSignal,
    ): Promise<{ reached: boolean; state: ioBroker.State | null | undefined; waited: number }> {
        const start = Date.now();
        const deadline = start + timeoutSeconds * 1000;
        for (;;) {
            const state = await this.adapter.getForeignStateAsync(id, { user: this.user });
            const done = reached(state);
            if (done || Date.now() >= deadline || signal?.aborted) {
                return { reached: done, state, waited: Date.now() - start };
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(STATE_POLL_INTERVAL, deadline - Date.now())));
        }
    }

    /**
     * Whether a state value is the expected one, also if one of them is stored as a string ("21.5" and 21.5,
     * '{"a":1}' and {a: 1}).
     */
    private static sameValue(actual: unknown, expected: unknown): boolean {
        if (actual === null || actual === undefined || expected === null || expected === undefined) {
            return actual === expected;
        }
        const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
        return text(actual) === text(expected);
    }

    /**
     * The states without object. For a pattern, js-controller returns only the states of existing state objects,
     * except in its maintenance mode (only for the admin user), which reads the keys of the states database. The
     * objects are read with the rights of the adapter, as an object the user may not see is still an object. A
     * state without object has no ACL, so js-controller lets every user read it anyway.
     *
     * @param pattern IDs of the states to check, wildcards allowed
     * @returns how many states were checked, and the states without object
     */
    private async findOrphanStates(pattern: string): Promise<{ checked: number; orphans: Record<string, unknown>[] }> {
        // not a literal argument: the types of the adapter do not know `maintenance`
        const maintenance = { user: 'system.user.admin', maintenance: true } as const;
        const states = await this.adapter.getForeignStatesAsync(pattern, maintenance);
        // The state objects of all IDs the pattern may match
        const prefix = pattern.split('*')[0];
        const view = await this.adapter.getObjectViewAsync('system', 'state', {
            startkey: prefix,
            endkey: `${prefix}香`,
        });
        const objects = new Set(view.rows.map(row => row.id));
        const orphans: Record<string, unknown>[] = [];
        for (const id of Object.keys(states).sort()) {
            // the rare state of an object of another type is no orphan either
            if (objects.has(id) || (await this.adapter.getForeignObjectAsync(id))) {
                continue;
            }
            const state = states[id];
            orphans.push({ id, val: state?.val, ack: state?.ack, ts: state?.ts, from: state?.from });
        }
        return { checked: Object.keys(states).length, orphans };
    }

    /** Coerce an arbitrary value to the given ioBroker state type. */
    private static coerceValue(value: unknown, type: ioBroker.CommonType | undefined): ioBroker.StateValue {
        if (value === null || value === undefined) {
            return value as ioBroker.StateValue;
        }
        if (type === 'number') {
            if (typeof value === 'number') {
                return value;
            }
            if (typeof value === 'boolean') {
                return value ? 1 : 0;
            }
            if (typeof value === 'string') {
                const n = parseFloat(value);
                return isNaN(n) ? value : n;
            }
            return value as ioBroker.StateValue;
        }
        if (type === 'boolean') {
            if (typeof value === 'boolean') {
                return value;
            }
            if (typeof value === 'number') {
                return !!value;
            }
            if (typeof value === 'string') {
                return value.toLowerCase() === 'true' || value === '1';
            }
            return value as ioBroker.StateValue;
        }
        if (type === 'string') {
            if (typeof value === 'string') {
                return value;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                return value.toString();
            }
            return JSON.stringify(value);
        }
        return value as ioBroker.StateValue;
    }

    /**
     * Read a (window of a) file from an adapter file storage.
     *
     * At most `length` bytes starting at byte `offset` are returned, so files of any size can be fetched in chunks
     * without exceeding the tool-result size limit of MCP clients. For UTF-8 text the window edges are moved to
     * character boundaries, so a multibyte character is never split; `nextOffset` always points at the first byte
     * that was not returned and can be passed as `offset` of the next call.
     */
    private async readFile(
        path: string,
        base64?: boolean,
        offset = 0,
        length = DEFAULT_MAX_READ_BYTES,
    ): Promise<{
        path: string;
        mimeType?: string;
        encoding: 'utf8' | 'base64';
        content: string;
        /** Total file size in bytes */
        size: number;
        /** Byte offset of the first returned byte */
        offset: number;
        /** Number of file bytes contained in `content` (before base64 encoding) */
        length: number;
        /** `true` when the file has more bytes after this chunk */
        truncated: boolean;
        /** Offset for the next call to continue reading; only present when `truncated` */
        nextOffset?: number;
    }> {
        const { adapterName, fileName } = McpServer.parseFilePath(path);
        const data = await this.adapter.readFileAsync(adapterName, fileName, { user: this.user });
        const file = (data as { file?: string | Buffer })?.file;
        const mimeType = (data as { mimeType?: string })?.mimeType;
        if (file === undefined || file === null) {
            throw new Error(`File "${path}" not found`);
        }
        const asText = !base64 && typeof file === 'string';
        const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
        const size = buffer.length;

        let start = Math.min(Math.max(0, Math.floor(offset)), size);
        let end = Math.min(start + Math.max(1, Math.floor(length)), size);
        if (asText) {
            // Never split a multibyte UTF-8 sequence: continuation bytes are 0b10xxxxxx.
            const isContinuation = (i: number): boolean => (buffer[i] & 0xc0) === 0x80;
            while (start < end && isContinuation(start)) {
                start++;
            }
            while (end > start && end < size && isContinuation(end)) {
                end--;
            }
            if (end === start && start < size) {
                // `length` is smaller than one character: return at least that whole character to guarantee progress.
                end = start + 1;
                while (end < size && isContinuation(end)) {
                    end++;
                }
            }
        }

        const chunk = buffer.subarray(start, end);
        const truncated = end < size;
        return {
            path,
            mimeType,
            encoding: asText ? 'utf8' : 'base64',
            content: chunk.toString(asText ? 'utf8' : 'base64'),
            size,
            offset: start,
            length: chunk.length,
            truncated,
            ...(truncated ? { nextOffset: end } : {}),
        };
    }

    /** Write a file to an adapter file storage. */
    private async writeFile(path: string, content: string, base64?: boolean): Promise<void> {
        const { adapterName, fileName } = McpServer.parseFilePath(path);
        const data: string | Buffer = base64 ? Buffer.from(content, 'base64') : content;
        await this.adapter.writeFileAsync(adapterName, fileName, data, { user: this.user });
    }

    /** List a directory in an adapter file storage. */
    private async listFiles(path: string): Promise<Record<string, unknown>[]> {
        const { adapterName, dirName } = McpServer.parseDirPath(path);
        const entries = await this.adapter.readDirAsync(adapterName, dirName, { user: this.user });
        return (entries || []).map(entry => ({
            file: entry.file,
            isDir: !!entry.isDir,
            size: entry.stats?.size,
            modified: entry.modifiedAt,
        }));
    }

    /** Rename/move a file within the same adapter file storage. */
    private async renameFile(path: string, newPath: string): Promise<void> {
        const from = McpServer.parseFilePath(path);
        const to = McpServer.parseFilePath(newPath);
        if (from.adapterName !== to.adapterName) {
            throw new Error('Renaming across adapter storages is not supported; both paths must share the adapter');
        }
        await this.adapter.renameAsync(from.adapterName, from.fileName, to.fileName, { user: this.user });
    }

    /** Create or update an object, merging common/native into an existing object (n8n `setIobObject`). */
    private async setObject(id: string, obj: Partial<ioBroker.Object>): Promise<{ id: string }> {
        let existing = await this.adapter.getForeignObjectAsync(id, { user: this.user });
        if (existing) {
            if (obj.common) {
                existing.common = { ...existing.common, ...obj.common } as ioBroker.ObjectCommon;
            }
            if (obj.native) {
                existing.native = { ...existing.native, ...obj.native };
            }
        } else {
            existing = obj as ioBroker.Object;
        }
        return this.adapter.setForeignObjectAsync(id, existing, { user: this.user });
    }

    /** Split a file path "<adapter>/<dir>/<file>" into adapter name and file name. */
    private static parseFilePath(path: string): { adapterName: string; fileName: string } {
        const [adapterName, ...rest] = path.replace(/^\//, '').split('/');
        if (!adapterName) {
            throw new Error('Path must start with an adapter name, e.g. "vis-2.0/main/vis-views.json"');
        }
        const fileName = rest.join('/');
        if (!fileName) {
            throw new Error('Path must contain a file name after the adapter, e.g. "vis-2.0/main/vis-views.json"');
        }
        return { adapterName, fileName };
    }

    /** Split a directory path "<adapter>[/<dir>]" into adapter name and (possibly empty) directory. */
    private static parseDirPath(path: string): { adapterName: string; dirName: string } {
        const [adapterName, ...rest] = path.replace(/^\//, '').replace(/\/$/, '').split('/');
        if (!adapterName) {
            throw new Error('Path must start with an adapter name, e.g. "vis-2.0/main" or "0_userdata.0"');
        }
        return { adapterName, dirName: rest.join('/') };
    }

    /** Delete an object, optionally with all its children. */
    private async deleteObject(id: string, recursive?: boolean): Promise<void> {
        const existing = await this.adapter.getForeignObjectAsync(id, { user: this.user });
        if (!existing) {
            throw new Error(`Object "${id}" does not exist`);
        }
        await this.adapter.delForeignObjectAsync(id, { user: this.user, recursive: !!recursive });
    }

    /** Create a new state object; refuses to overwrite an existing object. */
    private async createState(params: {
        id: string;
        name?: string;
        type?: ioBroker.CommonType;
        role?: string;
        read?: boolean;
        write?: boolean;
        unit?: string;
        min?: number;
        max?: number;
        step?: number;
        def?: unknown;
        desc?: string;
    }): Promise<{ id: string }> {
        const existing = await this.adapter.getForeignObjectAsync(params.id, { user: this.user });
        if (existing) {
            throw new Error(`Object "${params.id}" already exists - use set_object to modify it`);
        }
        const common: ioBroker.StateCommon = {
            name: params.name || params.id.split('.').pop() || params.id,
            type: params.type || 'mixed',
            role: params.role || 'state',
            read: params.read !== false,
            write: params.write !== false,
        };
        if (params.unit !== undefined) {
            common.unit = params.unit;
        }
        if (params.min !== undefined) {
            common.min = params.min;
        }
        if (params.max !== undefined) {
            common.max = params.max;
        }
        if (params.step !== undefined) {
            common.step = params.step;
        }
        if (params.desc !== undefined) {
            common.desc = params.desc;
        }
        await this.adapter.setForeignObjectAsync(params.id, { type: 'state', common, native: {} }, { user: this.user });
        if (params.def !== undefined) {
            const coerced = McpServer.coerceValue(params.def, common.type);
            await this.adapter.setForeignStateAsync(params.id, coerced, true, { user: this.user });
        }
        return { id: params.id };
    }

    /** Create or update a scene object for the ioBroker "scenes" adapter. */
    private async createScene(params: {
        name: string;
        members: { id: string; value: unknown }[];
        instance?: string;
        description?: string;
    }): Promise<{ id: string; members: number }> {
        const instance = params.instance || 'scene.0';
        const instanceObj = await this.adapter.getForeignObjectAsync(`system.adapter.${instance}`, {
            user: this.user,
        });
        if (!instanceObj) {
            throw new Error(
                `Scene adapter instance "${instance}" is not installed. Install the ioBroker "scenes" adapter first.`,
            );
        }
        // Scene IDs may not contain the characters that are forbidden in ioBroker IDs.
        const sceneName = params.name.replace(/[\s.*?"'[\]]/g, '_');
        const id = `${instance}.${sceneName}`;

        const sceneObj: ioBroker.SettableObject = {
            type: 'state',
            common: {
                name: params.name,
                type: 'boolean',
                role: 'scene.state',
                desc: params.description || '',
                read: true,
                write: true,
                def: false,
                engine: `system.adapter.${instance}`,
                enabled: true,
            } as ioBroker.StateCommon,
            native: {
                onTrue: { trigger: {}, cron: null, astro: null },
                onFalse: { enabled: false, trigger: {}, cron: null, astro: null },
                members: params.members.map(member => ({
                    id: member.id,
                    setIfTrue: member.value,
                    setIfFalse: null,
                    stopAllDelays: true,
                    delay: 0,
                    disabled: false,
                })),
                burstInterval: 0,
            },
        };
        await this.adapter.setForeignObjectAsync(id, sceneObj, { user: this.user });
        return { id, members: params.members.length };
    }

    /**
     * Install an adapter package on a host via `cmdExec` (`iobroker url ...`), the same way
     * ioBroker.admin installs from a custom URL or a .tgz file, and wait for the result.
     */
    private async installPackage(params: {
        source?: string;
        file_path?: string;
        file_name?: string;
        file_content?: string;
        upload_id?: string;
        host?: string;
        debug?: boolean;
        restart_instances?: boolean;
        start_timeout?: number;
        timeout?: number;
    }): Promise<Record<string, unknown>> {
        const given = [params.source, params.file_path, params.file_content, params.upload_id].filter(
            one => one !== undefined,
        );
        if (given.length !== 1) {
            throw new Error('Give exactly one of "source", "file_path", "file_name" + "file_content" or "upload_id"');
        }
        const host = await this.resolveHost(params.host);
        let upload: Transfer | undefined;
        if (params.upload_id !== undefined) {
            upload = this.getUpload(params.upload_id);
            if (!upload.name.toLowerCase().endsWith('.tgz')) {
                throw new Error('Only .tgz files can be installed');
            }
        }

        let source: string;
        let files: { name: string; file: string }[] | undefined;
        if (params.source !== undefined) {
            source = params.source.trim();
            // The host splits the command at spaces, so a source must be one argument and no option
            if (!source || /\s/.test(source) || source.startsWith('-')) {
                throw new Error(`Invalid source "${params.source}"`);
            }
            // a pure adapter name, like in the "Custom URL" tab of admin
            if (!/[./:]/.test(source)) {
                source = `iobroker.${source}`;
            }
        } else {
            let fileName: string;
            let data: Buffer;
            if (params.file_path !== undefined) {
                const { adapterName, fileName: storageName } = McpServer.parseFilePath(params.file_path);
                const result = await this.adapter.readFileAsync(adapterName, storageName, { user: this.user });
                data = Buffer.isBuffer(result.file) ? result.file : Buffer.from(result.file || '');
                fileName = storageName.split('/').pop() || '';
            } else if (upload) {
                data = fs.readFileSync(upload.file);
                fileName = upload.name;
            } else {
                if (!params.file_name) {
                    throw new Error('"file_content" requires "file_name"');
                }
                data = Buffer.from(params.file_content!, 'base64');
                fileName = params.file_name;
            }
            if (!fileName.toLowerCase().endsWith('.tgz')) {
                throw new Error('Only .tgz files can be installed');
            }
            if (!data.length) {
                throw new Error('The .tgz file is empty');
            }
            if (!this.adapter.supportsFeature?.('CONTROLLER_CMD_EXEC_FILES')) {
                throw new Error('Installing a .tgz file requires a js-controller that supports files in cmdExec');
            }
            // The command refers to the file by name, so it must not contain spaces, "/" or "\"
            source = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
            files = [{ name: source, file: data.toString('base64') }];
        }

        const result = await this.runHostCommand(
            host,
            `url ${source} --host ${host}${params.debug ? ' --debug' : ''}`,
            params.timeout,
            files,
        );
        if (upload && result.finished) {
            this.removeTransfer(params.upload_id!);
        }
        const adapterName = extractAdapterName(
            params.file_path || params.file_name || upload?.name || params.source || '',
        );
        // The package is installed at this point: errors from here on are reported, not thrown, so the
        // caller still learns that the installation happened
        const restartTs = Date.now();
        const restarted: string[] = [];
        let restartError: string | undefined;
        if (result.success && adapterName && params.restart_instances !== false) {
            try {
                await this.restartAdapterInstances(adapterName, restarted);
            } catch (e) {
                restartError = `Installed, but the instances could not be restarted: ${e instanceof Error ? e.message : e}`;
            }
        }
        const startTimeout = params.start_timeout ?? DEFAULT_START_TIMEOUT;
        let instances: Record<string, unknown>[] | undefined;
        if (restarted.length && startTimeout) {
            try {
                instances = await this.waitForStart(restarted, restartTs, startTimeout);
            } catch (e) {
                restartError ??= `Installed, but the start of the instances could not be checked: ${e instanceof Error ? e.message : e}`;
            }
        }
        return {
            ...result,
            adapter: adapterName,
            restartedInstances: restarted,
            ...(restartError ? { restartError } : {}),
            ...(instances ? { instances } : {}),
        };
    }

    /**
     * Wait until restarted instances report `alive` again, then collect their first log lines since the restart.
     * Instances that are not daemons (schedule, once, ...) do not stay alive and are not waited for.
     *
     * @param ids instance ids like `hue.0`
     * @param since time of the restart (ms); only an `alive` and log lines after it count
     * @param timeoutSeconds how long to wait for all instances together
     */
    private async waitForStart(
        ids: string[],
        since: number,
        timeoutSeconds: number,
    ): Promise<Record<string, unknown>[]> {
        const results: Record<string, unknown>[] = [];
        const deadline = since + timeoutSeconds * 1000;
        for (const id of ids) {
            const obj = await this.adapter.getForeignObjectAsync(`system.adapter.${id}`, { user: this.user });
            const mode = (obj?.common as ioBroker.InstanceCommon | undefined)?.mode;
            if (mode && mode !== 'daemon') {
                results.push({ id, mode, note: `Not checked: a ${mode} instance does not stay running` });
                continue;
            }
            let alive = false;
            for (;;) {
                const state = await this.adapter.getForeignStateAsync(`system.adapter.${id}.alive`, {
                    user: this.user,
                });
                // `lc`, not `ts`: the heartbeat of the old process refreshes `ts` until it is stopped
                alive = !!state?.val && (state.lc ?? state.ts) >= since;
                if (alive || Date.now() >= deadline) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            results.push({ id, alive, ...(alive ? {} : { note: `Not alive after ${timeoutSeconds}s` }) });
        }
        // The first lines since the restart show whether the start went well
        try {
            for (const entry of results) {
                if (entry.mode) {
                    continue;
                }
                const { logs } = await this.getLogs({ adapter: entry.id as string, from_ts: since, limit: 500 });
                entry.logs = logs.slice(0, START_LOG_LINES).map(log => ({
                    ts: log.ts,
                    level: log.level,
                    message: log.message,
                }));
            }
        } catch (e) {
            this.adapter.log.debug(`Cannot read the log after the restart: ${e instanceof Error ? e.message : e}`);
        }
        return results;
    }

    /** Normalize a host name (with or without `system.host.`) and check that the host exists. */
    private async resolveHost(host?: string): Promise<string> {
        const name = (host || this.adapter.host || '').replace(/^system\.host\./, '');
        if (!name || /\s/.test(name)) {
            throw new Error(`Invalid host "${name}"`);
        }
        const hostObj = await this.adapter.getForeignObjectAsync(`system.host.${name}`, { user: this.user });
        if (hostObj?.type !== 'host') {
            throw new Error(`Host "${name}" not found`);
        }
        return name;
    }

    /**
     * Run an ioBroker CLI command on a host via `cmdExec` and wait for its exit code. The host reports
     * the output and the exit code as messages to this instance, see {@link onMessage}.
     *
     * @param host host name without `system.host.`
     * @param command the CLI arguments, e.g. `upgrade hue@3.9.0`
     * @param timeoutSeconds how long to wait; the command keeps running on the host after that
     * @param files files sent along with the command (the command refers to them by name)
     */
    private async runHostCommand(
        host: string,
        command: string,
        timeoutSeconds?: number,
        files?: { name: string; file: string }[],
    ): Promise<Record<string, unknown> & { success?: boolean }> {
        await this.assertOtherPermission('execute', `run "iobroker ${command}" on host "${host}"`);
        const id = `mcp-${randomUUID()}`;
        const timeout = (timeoutSeconds ?? DEFAULT_INSTALL_TIMEOUT) * 1000;
        const output: string[] = [];

        this.adapter.log.info(`[cmdExec] ${host}: iobroker ${command}`);
        const exitCode = await new Promise<number | null>(resolve => {
            const timer = setTimeout(() => {
                this.cmdSessions.delete(id);
                resolve(null);
            }, timeout);
            this.cmdSessions.set(id, {
                output,
                onExit: code => {
                    clearTimeout(timer);
                    resolve(code);
                },
            });
            this.adapter.sendToHost(`system.host.${host}`, 'cmdExec', { data: command, id, files });
        });

        return {
            host,
            command: `iobroker ${command}`,
            ...(exitCode === null
                ? {
                      finished: false,
                      note: `No result after ${timeout / 1000}s - the command keeps running on the host, check the log`,
                  }
                : { finished: true, success: exitCode === 0, exitCode }),
            output,
        };
    }

    /** Request something from a host (`getNotifications`, ...) and wait for the answer. */
    private hostRequest(host: string, command: string, message: unknown): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Host "${host}" did not answer "${command}"`)), 10_000);
            this.adapter.sendToHost(`system.host.${host}`, command, message, (result: any) => {
                clearTimeout(timer);
                if (result?.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result);
                }
            });
        });
    }

    /**
     * Like admin after an installation: touching the instance objects makes the controller restart them.
     *
     * @param adapterName adapter whose enabled instances are restarted
     * @param restarted receives the ids of the restarted instances, also those before an error
     */
    private async restartAdapterInstances(adapterName: string, restarted: string[]): Promise<void> {
        const instances = await this.adapter.getForeignObjectsAsync(`system.adapter.${adapterName}.*`, 'instance', {
            user: this.user,
        });
        for (const [instanceId, instance] of Object.entries(instances || {})) {
            if (instance?.common?.enabled) {
                await this.adapter.extendForeignObjectAsync(instanceId, {}, { user: this.user });
                restarted.push(instanceId.replace('system.adapter.', ''));
            }
        }
    }

    /** Read an instance object by its short id (`hue.0`) or full id (`system.adapter.hue.0`). */
    private async getInstance(id: string): Promise<{ id: string; fullId: string; obj: ioBroker.InstanceObject }> {
        const shortId = id.replace(/^system\.adapter\./, '');
        if (!/^[a-z0-9][a-z0-9_-]*\.\d+$/i.test(shortId)) {
            throw new Error(`Invalid instance "${id}", expected e.g. "hue.0"`);
        }
        const fullId = `system.adapter.${shortId}`;
        const obj = await this.adapter.getForeignObjectAsync(fullId, { user: this.user });
        if (obj?.type !== 'instance') {
            throw new Error(`Instance "${shortId}" not found`);
        }
        return { id: shortId, fullId, obj: obj };
    }

    /** Start (enable) or stop (disable) an instance. */
    private async setInstanceEnabled(id: string, enabled: boolean): Promise<Record<string, unknown>> {
        const instance = await this.getInstance(id);
        const changed = !!instance.obj.common.enabled !== enabled;
        if (changed) {
            await this.adapter.extendForeignObjectAsync(instance.fullId, { common: { enabled } }, { user: this.user });
        }
        return { id: instance.id, enabled, changed };
    }

    /** Restart a running instance. */
    private async restartInstance(id: string): Promise<Record<string, unknown>> {
        const instance = await this.getInstance(id);
        if (!instance.obj.common.enabled) {
            throw new Error(`Instance "${instance.id}" is not enabled - start it instead`);
        }
        await this.adapter.extendForeignObjectAsync(instance.fullId, {}, { user: this.user });
        return { id: instance.id, restarted: true };
    }

    /**
     * Change the log level of an instance: temporarily via its `logLevel` state (no restart, until the
     * next start), or persistently in the instance object (restarts the instance).
     */
    private async setLogLevel(
        id: string,
        level: ioBroker.LogLevel,
        persistent?: boolean,
    ): Promise<Record<string, unknown>> {
        const instance = await this.getInstance(id);
        if (persistent) {
            await this.adapter.extendForeignObjectAsync(
                instance.fullId,
                { common: { loglevel: level } },
                { user: this.user },
            );
        } else {
            await this.adapter.setForeignStateAsync(`${instance.fullId}.logLevel`, level, false, {
                user: this.user,
            });
        }
        return { id: instance.id, level, persistent: !!persistent };
    }

    /** Check an adapter name, as the CLI receives it as an argument. */
    private static checkAdapterName(name: string): string {
        const adapterName = name
            .trim()
            .replace(/^iobroker\./i, '')
            .toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(adapterName)) {
            throw new Error(`Invalid adapter name "${name}"`);
        }
        return adapterName;
    }

    /** Create an instance of an adapter (installs the adapter from the repository if necessary). */
    private async addInstance(params: {
        adapter: string;
        instance?: number;
        host?: string;
        timeout?: number;
    }): Promise<Record<string, unknown>> {
        const adapterName = McpServer.checkAdapterName(params.adapter);
        const host = await this.resolveHost(params.host);
        if (params.instance !== undefined) {
            const existing = await this.adapter.getForeignObjectAsync(
                `system.adapter.${adapterName}.${params.instance}`,
                { user: this.user },
            );
            if (existing) {
                throw new Error(`Instance "${adapterName}.${params.instance}" already exists`);
            }
        }
        return this.runHostCommand(
            host,
            `add ${adapterName}${params.instance !== undefined ? ` ${params.instance}` : ''} --host ${host}`,
            params.timeout,
        );
    }

    /** Delete an instance with its objects and states (on the host it runs on). */
    private async deleteInstance(params: { id: string; timeout?: number }): Promise<Record<string, unknown>> {
        const instance = await this.getInstance(params.id);
        const host = await this.resolveHost(instance.obj.common.host);
        return this.runHostCommand(host, `del ${instance.id}`, params.timeout);
    }

    /** Upgrade an installed adapter to the repository version (or the given one). */
    private async upgradeAdapter(params: {
        adapter: string;
        version?: string;
        host?: string;
        timeout?: number;
    }): Promise<Record<string, unknown>> {
        const adapterName = McpServer.checkAdapterName(params.adapter);
        if (params.version !== undefined && !/^\d+\.\d+\.\d+[\w.+-]*$/.test(params.version)) {
            throw new Error(`Invalid version "${params.version}"`);
        }
        const adapterObj = await this.adapter.getForeignObjectAsync(`system.adapter.${adapterName}`, {
            user: this.user,
        });
        if (adapterObj?.type !== 'adapter') {
            throw new Error(`Adapter "${adapterName}" is not installed - use add_instance to install it`);
        }
        const version = params.version || (await this.getRepositoryJson())[adapterName]?.version;
        if (!version) {
            throw new Error(`Adapter "${adapterName}" is not in the active repository, give a version`);
        }
        const host = await this.resolveHost(params.host);
        return this.runHostCommand(host, `upgrade ${adapterName}@${version}`, params.timeout);
    }

    /** List the installed adapters that have a newer version in the active repository. */
    private async listAdapterUpdates(): Promise<Record<string, unknown>[]> {
        const repo = await this.getRepositoryJson();
        const result: Record<string, unknown>[] = [];
        for (const adapter of await this.listAdapters()) {
            const name = adapter.name as string;
            const available = repo[name]?.version as string | undefined;
            if (available && compareVersions(available, adapter.version as string) > 0) {
                result.push({ name, installed: adapter.version, available, title: adapter.title });
            }
        }
        return result;
    }

    /**
     * Read the JSON of the active repositories from `system.repositories` (or of all repositories if none
     * is marked active). An adapter present in several repos is kept once (first/active repo wins). This
     * matters when the user has custom repos active next to the default one.
     */
    private async getRepositoryJson(): Promise<Record<string, any>> {
        const reposObj = await this.adapter.getForeignObjectAsync('system.repositories', { user: this.user });
        const repositories = (reposObj?.native?.repositories || {}) as Record<string, { json?: Record<string, any> }>;

        const sysCfg = await this.adapter.getForeignObjectAsync('system.config', { user: this.user });
        const active = sysCfg?.common?.activeRepo;
        const activeNames = Array.isArray(active) ? active : active ? [active] : [];

        const activeWithJson = activeNames.filter(name => repositories[name]?.json);
        const sources = (
            activeWithJson.length ? activeWithJson.map(name => repositories[name]) : Object.values(repositories)
        )
            .map(repo => repo?.json)
            .filter((j): j is Record<string, any> => !!j);
        const json: Record<string, any> = {};
        for (const src of sources) {
            for (const key of Object.keys(src)) {
                if (!(key in json)) {
                    json[key] = src[key];
                }
            }
        }
        return json;
    }

    /** Read the current notifications of one or all hosts, one entry per category and instance. */
    private async listNotifications(params: {
        host?: string;
        language?: ioBroker.Languages;
    }): Promise<Record<string, unknown>[]> {
        const lang = params.language || this.language;
        const hosts = params.host
            ? [await this.resolveHost(params.host)]
            : (await this.listHosts()).filter(host => host.alive).map(host => host.id as string);

        const result: Record<string, unknown>[] = [];
        for (const host of hosts) {
            const answer = await this.hostRequest(host, 'getNotifications', {});
            const scopes = (answer?.result || {}) as Record<string, any>;
            for (const [scope, scopeObj] of Object.entries(scopes)) {
                const categories = (scopeObj?.categories || {}) as Record<string, any>;
                for (const [category, categoryObj] of Object.entries(categories)) {
                    const instances = (categoryObj?.instances || {}) as Record<string, any>;
                    for (const [instance, instanceObj] of Object.entries(instances)) {
                        const messages = (instanceObj?.messages || []) as { message: string; ts: number }[];
                        if (!messages.length) {
                            continue;
                        }
                        result.push({
                            host,
                            scope,
                            category,
                            instance: instance.replace(/^system\.adapter\./, ''),
                            severity: categoryObj.severity,
                            name: getText(categoryObj.name, lang),
                            description: getText(categoryObj.description, lang),
                            messages: messages.map(one => ({ message: one.message, ts: one.ts })),
                        });
                    }
                }
            }
        }
        return result;
    }

    /** Acknowledge (delete) notifications on a host, optionally only of one scope/category/instance. */
    private async clearNotifications(params: {
        host?: string;
        scope?: string;
        category?: string;
        instance?: string;
    }): Promise<Record<string, unknown>> {
        const host = await this.resolveHost(params.host);
        const instance = params.instance ? `system.adapter.${params.instance.replace(/^system\.adapter\./, '')}` : null;
        await this.hostRequest(host, 'clearNotifications', {
            scope: params.scope || null,
            category: params.category || null,
            instance,
        });
        return { host, cleared: true };
    }

    /**
     * Normalize a script id: `script.js.common.lights`, `common.lights` or `lights` (folder `common`).
     * Every segment is reduced to the characters the javascript editor uses for ids.
     */
    private static scriptId(id: string): string {
        let path = id.trim().replace(/^script\.js\./, '');
        if (!path.includes('.')) {
            path = `common.${path}`;
        }
        const segments = path.split('.').map(segment => segment.trim().replace(/[^\p{L}\p{N}_-]/gu, '_'));
        if (segments.some(segment => !segment)) {
            throw new Error(`Invalid script id "${id}"`);
        }
        return `script.js.${segments.join('.')}`;
    }

    /** Summary of a script object, optionally with its source. */
    private scriptInfo(id: string, obj: ioBroker.Object, withSource?: boolean): Record<string, unknown> {
        const common = (obj.common || {}) as Partial<ioBroker.ScriptCommon>;
        return {
            id,
            name: this.getName(common.name),
            engineType: common.engineType || 'Javascript/js',
            enabled: !!common.enabled,
            engine: (common.engine || '').replace(/^system\.adapter\./, ''),
            ...(withSource ? { source: common.source || '' } : {}),
        };
    }

    /** Read a script object, failing if it is missing or not a script. */
    private async getScriptObject(id: string): Promise<{ id: string; obj: ioBroker.Object }> {
        const scriptId = McpServer.scriptId(id);
        const obj = await this.adapter.getForeignObjectAsync(scriptId, { user: this.user });
        if (obj?.type !== 'script') {
            throw new Error(`Script "${scriptId}" not found`);
        }
        return { id: scriptId, obj };
    }

    /** List the scripts of the javascript adapter (without their source). */
    private async listScripts(folder?: string): Promise<Record<string, unknown>[]> {
        const prefix = folder ? `script.js.${folder.replace(/^script\.js\./, '').replace(/\.$/, '')}.` : 'script.js.';
        const objs = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'script', { user: this.user });
        return Object.entries(objs || {}).map(([id, obj]) => this.scriptInfo(id, obj));
    }

    /**
     * Create a script or change the source of an existing one. Blockly and Rules scripts keep their
     * blocks in the source, so they are not changed. New scripts start disabled unless `enabled` is given.
     */
    private async setScript(params: {
        id: string;
        source: string;
        engineType?: 'Javascript/js' | 'TypeScript/ts';
        name?: string;
        enabled?: boolean;
        instance?: string;
    }): Promise<Record<string, unknown>> {
        const scriptId = McpServer.scriptId(params.id);
        const existing = await this.adapter.getForeignObjectAsync(scriptId, { user: this.user });
        if (existing && existing.type !== 'script') {
            throw new Error(`"${scriptId}" exists and is not a script`);
        }
        if (existing) {
            const engineType = (existing.common as Partial<ioBroker.ScriptCommon>).engineType || 'Javascript/js';
            if (!/^(javascript|typescript)/i.test(engineType)) {
                throw new Error(`"${scriptId}" is a ${engineType} script; only JavaScript/TypeScript can be changed`);
            }
            const common: Partial<ioBroker.ScriptCommon> = { source: params.source };
            if (params.name !== undefined) {
                common.name = params.name;
            }
            if (params.enabled !== undefined) {
                common.enabled = params.enabled;
            }
            await this.adapter.extendForeignObjectAsync(scriptId, { common }, { user: this.user });
            return { id: scriptId, created: false };
        }

        const engine = (await this.getInstance(params.instance || 'javascript.0')).id;
        // The parent folders are channels, like the javascript editor creates them
        const segments = scriptId.split('.');
        for (let i = 3; i < segments.length; i++) {
            const folderId = segments.slice(0, i).join('.');
            if (!(await this.adapter.getForeignObjectAsync(folderId, { user: this.user }))) {
                await this.adapter.setForeignObjectAsync(
                    folderId,
                    { type: 'channel', common: { name: segments[i - 1] }, native: {} },
                    { user: this.user },
                );
            }
        }
        await this.adapter.setForeignObjectAsync(
            scriptId,
            {
                type: 'script',
                common: {
                    name: params.name || segments[segments.length - 1],
                    expert: true,
                    engineType: params.engineType || 'Javascript/js',
                    enabled: !!params.enabled,
                    engine: `system.adapter.${engine}`,
                    source: params.source,
                    debug: false,
                    verbose: false,
                },
                native: {},
            } as unknown as ioBroker.ScriptObject,
            { user: this.user },
        );
        return { id: scriptId, created: true };
    }

    /** Enable (start) or disable (stop) a script. */
    private async enableScript(id: string, enabled: boolean): Promise<Record<string, unknown>> {
        const script = await this.getScriptObject(id);
        await this.adapter.extendForeignObjectAsync(script.id, { common: { enabled } }, { user: this.user });
        return { id: script.id, enabled };
    }

    /** Delete a script. */
    private async deleteScript(id: string): Promise<Record<string, unknown>> {
        const script = await this.getScriptObject(id);
        await this.adapter.delForeignObjectAsync(script.id, { user: this.user });
        return { id: script.id, deleted: true };
    }

    /**
     * Run code once in the javascript adapter (its `execute` message) and return what it logged. Nothing
     * is stored; timers and subscriptions are cleaned up after `timeout`.
     */
    private async runScript(params: {
        source: string;
        engineType?: 'Javascript/js' | 'TypeScript/ts';
        timeout?: number;
        instance?: string;
    }): Promise<Record<string, unknown>> {
        const instance = await this.getInstance(params.instance || 'javascript.0');
        await this.assertOtherPermission('sendto', `run code in "${instance.id}"`);
        const timeout = params.timeout ?? 5000;
        const result = await this.adapter.sendToAsync(
            instance.id,
            'execute',
            { source: params.source, engineType: params.engineType, timeout, verbose: false, logLevel: 'info' },
            { timeout: timeout + 15_000, user: this.user },
        );
        if (!result || typeof result !== 'object') {
            throw new Error(`"${instance.id}" did not answer - javascript adapter 10.1.0 or newer is required`);
        }
        return result as Record<string, unknown>;
    }

    /** Whether `send_to` may address this instance (by adapter name, instance or `*`). */
    private isSendToAllowed(instance: string): boolean {
        const allowed = (this.config.sendToAllowlist || '')
            .split(/[\s,;]+/)
            .map(one => one.replace(/^system\.adapter\./, ''))
            .filter(Boolean);
        return allowed.includes('*') || allowed.includes(instance) || allowed.includes(instance.split('.')[0]);
    }

    /** Send a message to an adapter instance (`sendTo`) and return its answer. */
    private async sendToInstance(params: {
        instance: string;
        command: string;
        message?: unknown;
        timeout?: number;
    }): Promise<Record<string, unknown>> {
        const instance = await this.getInstance(params.instance);
        if (!this.isSendToAllowed(instance.id)) {
            throw new Error(`"${instance.id}" is not in the allowlist of send_to`);
        }
        await this.assertOtherPermission('sendto', `send messages to "${instance.id}"`);
        const response = await this.adapter.sendToAsync(
            instance.id,
            params.command,
            (params.message ?? {}) as ioBroker.MessagePayload,
            { timeout: params.timeout ?? 10_000, user: this.user },
        );
        return { instance: instance.id, command: params.command, response: response ?? null };
    }

    /**
     * Create an alias (`alias.0.*`) that points to another state. Type, role, unit and limits are copied
     * from the target unless given.
     */
    private async createAlias(params: {
        id: string;
        target: string;
        write_target?: string;
        name?: string;
        role?: string;
        unit?: string;
    }): Promise<Record<string, unknown>> {
        const id = params.id.startsWith('alias.') ? params.id : `alias.0.${params.id}`;
        if (!/^alias\.\d+\.[^*\s]+$/.test(id)) {
            throw new Error(`Invalid alias id "${params.id}"`);
        }
        if (await this.adapter.getForeignObjectAsync(id, { user: this.user })) {
            throw new Error(`Object "${id}" already exists`);
        }
        const target = await this.adapter.getForeignObjectAsync(params.target, { user: this.user });
        if (target?.type !== 'state') {
            throw new Error(`Target "${params.target}" is not a state`);
        }
        if (params.write_target) {
            const writeTarget = await this.adapter.getForeignObjectAsync(params.write_target, {
                user: this.user,
            });
            if (writeTarget?.type !== 'state') {
                throw new Error(`Write target "${params.write_target}" is not a state`);
            }
        }
        const source = target.common as ioBroker.StateCommon;
        const common: Record<string, unknown> = {
            name: params.name || source.name || id.split('.').pop(),
            type: source.type || 'mixed',
            role: params.role || source.role || 'state',
            read: source.read !== false,
            write: params.write_target ? true : source.write !== false,
            alias: {
                id: params.write_target ? { read: params.target, write: params.write_target } : params.target,
            },
        };
        for (const key of ['min', 'max', 'step', 'states'] as const) {
            if (source[key] !== undefined) {
                common[key] = source[key];
            }
        }
        if (params.unit !== undefined || source.unit !== undefined) {
            common.unit = params.unit ?? source.unit;
        }
        await this.adapter.setForeignObjectAsync(
            id,
            { type: 'state', common, native: {} } as unknown as ioBroker.StateObject,
            { user: this.user },
        );
        return { id, target: params.target, ...(params.write_target ? { write_target: params.write_target } : {}) };
    }

    /**
     * Create a download link for `data`, or an upload link when `data` is undefined, and return its
     * token. The file lives in a temporary folder until the link expires (or the upload is used).
     */
    private createTransfer(
        kind: Transfer['kind'],
        name: string,
        data?: string | Buffer,
        contentType = 'application/octet-stream',
    ): string {
        this.cleanupTransfers();
        if (!this.transferDir) {
            this.transferDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'iobroker-mcp-'));
            this.transferTimer = setInterval(() => this.cleanupTransfers(), 60_000);
            this.transferTimer.unref?.();
        }
        const token = randomBytes(32).toString('hex');
        // One folder per link, so the file keeps its name (`npm` needs the .tgz extension)
        const folder = nodePath.join(this.transferDir, token);
        // recursive: another MCP server may have removed our folder as stale (see removeStaleTransferDirs)
        fs.mkdirSync(folder, { recursive: true });
        const file = nodePath.join(folder, name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file');
        if (data !== undefined) {
            fs.writeFileSync(file, data);
        }
        this.transfers.set(token, {
            kind,
            name,
            file,
            contentType,
            expires: Date.now() + TRANSFER_TTL,
            size: data !== undefined ? Buffer.byteLength(data) : undefined,
            user: this.user,
        });
        return token;
    }

    /**
     * Remove the transfer folders that a process left behind when it was killed. Other MCP servers on this
     * host (web extension, standalone, admin) use the same temp folder, so only folders unchanged for longer
     * than a link lives are removed: every new link creates a subfolder and so touches its folder.
     */
    private removeStaleTransferDirs(): void {
        const tmp = os.tmpdir();
        try {
            for (const name of fs.readdirSync(tmp)) {
                if (!name.startsWith('iobroker-mcp-')) {
                    continue;
                }
                const dir = nodePath.join(tmp, name);
                try {
                    const stat = fs.statSync(dir);
                    if (stat.isDirectory() && Date.now() - stat.mtimeMs > TRANSFER_TTL) {
                        fs.rmSync(dir, { recursive: true, force: true });
                        this.adapter.log.debug(`Removed stale transfer folder "${dir}"`);
                    }
                } catch (e) {
                    this.adapter.log.debug(`Cannot remove stale transfer folder "${dir}": ${e}`);
                }
            }
        } catch (e) {
            this.adapter.log.debug(`Cannot read "${tmp}": ${e}`);
        }
    }

    /** The public URL of a download or upload link. */
    private transferUrl(baseUrl: string, token: string): string {
        return `${baseUrl}${this.mcpPath}/transfer/${token}`;
    }

    /** Remove a link and its file. */
    private removeTransfer(token: string): void {
        const transfer = this.transfers.get(token);
        if (transfer) {
            this.transfers.delete(token);
            try {
                fs.rmSync(nodePath.dirname(transfer.file), { recursive: true, force: true });
            } catch (e) {
                this.adapter.log.warn(`Cannot delete "${transfer.file}": ${e}`);
            }
        }
    }

    /** Remove the expired links. */
    private cleanupTransfers(): void {
        const now = Date.now();
        for (const [token, transfer] of this.transfers) {
            if (transfer.expires < now) {
                this.removeTransfer(token);
            }
        }
    }

    /** `GET <mcp>/transfer/<token>`: send the file of a download link. */
    private handleDownload(req: Request, res: Response): void {
        const transfer = this.transfers.get(String(req.params.token));
        if (!transfer || transfer.kind !== 'download' || transfer.expires < Date.now()) {
            res.status(404).json({ error: 'Unknown or expired link' });
            return;
        }
        res.setHeader('Content-Type', transfer.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${nodePath.basename(transfer.file)}"`);
        if (transfer.size !== undefined) {
            res.setHeader('Content-Length', transfer.size);
        }
        fs.createReadStream(transfer.file).pipe(res);
    }

    /** `PUT`/`POST <mcp>/transfer/<token>`: receive the file of an upload link (raw body, e.g. `curl -T`). */
    private async handleUpload(req: Request, res: Response): Promise<void> {
        const token = String(req.params.token);
        const transfer = this.transfers.get(token);
        if (!transfer || transfer.kind !== 'upload' || transfer.expires < Date.now()) {
            res.status(404).json({ error: 'Unknown or expired link' });
            return;
        }
        if (transfer.size !== undefined) {
            res.status(409).json({ error: 'This link was already used' });
            return;
        }
        try {
            transfer.size = await McpServer.receiveBody(req, transfer.file);
            this.adapter.log.info(`Received upload "${transfer.name}" (${transfer.size} bytes)`);
            res.json({ ok: true, upload_id: token, name: transfer.name, size: transfer.size });
        } catch (e) {
            const error = e as Error & { status?: number };
            fs.rmSync(transfer.file, { force: true });
            res.status(error.status || 400).json({ error: error.message });
        }
    }

    /** Write the raw body of a request to a file and return its size. */
    private static receiveBody(req: Request, file: string): Promise<number> {
        const tooLarge = (): Error =>
            Object.assign(new Error(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`), { status: 413 });

        // The body parsers of the web adapter may have read the stream already and kept the bytes
        const read = (req as Request & { rawBody?: Buffer }).rawBody ?? (Buffer.isBuffer(req.body) ? req.body : null);
        if (read) {
            if (read.length > MAX_UPLOAD_BYTES) {
                return Promise.reject(tooLarge());
            }
            fs.writeFileSync(file, read);
            return Promise.resolve(read.length);
        }

        return new Promise((resolve, reject) => {
            const out = fs.createWriteStream(file);
            let size = 0;
            req.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_UPLOAD_BYTES) {
                    req.unpipe(out);
                    out.destroy();
                    reject(tooLarge());
                }
            });
            req.on('error', reject);
            out.on('error', reject);
            out.on('finish', () => resolve(size));
            req.pipe(out);
        });
    }

    /**
     * Get a received upload by its id, failing if it is unknown, expired or still empty. An upload of
     * another user is reported as unknown, so a leaked id gives neither access nor a hint that it exists.
     */
    private getUpload(uploadId: string): Transfer {
        const transfer = this.transfers.get(uploadId);
        if (!transfer || transfer.kind !== 'upload' || transfer.expires < Date.now() || transfer.user !== this.user) {
            throw new Error(`Unknown or expired upload "${uploadId}" - create a new one with prepare_upload`);
        }
        if (transfer.size === undefined) {
            throw new Error(`Nothing was uploaded to "${uploadId}" yet - upload the file to its url first`);
        }
        return transfer;
    }

    // --- helpers ---

    /** Resolve the member ids of a room/function enum matched by id or (localized) name. */
    private async getEnumMembers(prefix: string, nameOrId: string): Promise<string[]> {
        const enums = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'enum', { user: this.user });
        const needle = nameOrId.toLowerCase();
        for (const [id, obj] of Object.entries(enums || {})) {
            if (id.toLowerCase() === needle || this.getName(obj?.common?.name).toLowerCase() === needle) {
                return (obj?.common?.members as string[]) || [];
            }
        }
        return [];
    }

    /** Normalize an ioBroker name (string or {en, de, ...}) to a plain string. */
    private getName(name: ioBroker.StringOrTranslated | undefined): string {
        if (!name) {
            return '';
        }
        if (typeof name === 'string') {
            return name;
        }
        return name.en || Object.values(name)[0] || '';
    }

    /** Parse an interval like "15m", "1h", "30s" into milliseconds. */
    private parseInterval(interval: string): number | undefined {
        const m = interval.match(/^(\d+)\s*(s|m|h|d)$/i);
        if (!m) {
            return undefined;
        }
        const value = parseInt(m[1], 10);
        const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()]!;
        return value * unit;
    }

    unload(): void {
        try {
            this.adapter.removeListener('log', this.onLog);
            this.adapter.removeListener('message', this.onMessage);
        } catch {
            // ignore
        }
        if (this.transferTimer) {
            clearInterval(this.transferTimer);
            this.transferTimer = undefined;
        }
        if (this.transferDir) {
            fs.rmSync(this.transferDir, { recursive: true, force: true });
            this.transferDir = undefined;
            this.transfers.clear();
        }
        for (const session of Object.values(this.sessions)) {
            try {
                void session.transport.close();
            } catch {
                // ignore
            }
        }
        this.adapter.log.info('MCP server unloading');
    }
}

export { McpServer, createInProcessMcp };
export type { McpConfig } from './types';
export type {
    InProcessMcp,
    InProcessMcpOptions,
    InProcessToolAnnotations,
    InProcessToolInfo,
    InProcessToolResult,
} from './inProcessClient';
