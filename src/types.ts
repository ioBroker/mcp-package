export interface McpConfig {
    webInstance: string;
    port: number | string;
    bind: string;
    auth: boolean;
    /**
     * Offer the browser-based OAuth2 authorization code flow with PKCE in addition to Bearer tokens
     * and HTTP Basic auth. This is what MCP clients such as Claude Desktop use when a connector is
     * added: the user logs in and confirms in the browser instead of pasting a token. Standalone
     * mode only — as a web extension the host `web` adapter owns authentication.
     */
    oauth?: boolean;
    /**
     * Externally reachable base URL of this server without a trailing slash, e.g.
     * `https://iobroker.example.com`. Required behind a reverse proxy: the URLs published in the
     * OAuth discovery documents must be the ones the client can actually reach. When empty, they are
     * derived from the incoming request.
     */
    publicUrl?: string;
    /**
     * Let MCP clients register themselves via RFC 7591 (default: true). Turning this off means every
     * client has to be registered by hand before it can connect.
     */
    oauthDynamicRegistration?: boolean;
    secure: boolean;
    /** Allow the `set_state`/`set_states`/`clear_notifications` tools to write states (default: true). */
    allowSetState: boolean;
    /** Declare `set_state`/`set_states` as destructive (`destructiveHint`), so clients can warn before writing (default: true). */
    setStateDestructive?: boolean;
    /** Allow the object/file changing tools (`set_object`, `delete_object`, `create_state`, `create_scene`, `create_alias`, `write_file`, `delete_file`, `rename_file`, `mkdir`) (default: false). */
    allowObjectChange: boolean;
    /** Allow starting, stopping and restarting instances and changing their log level (default: false). */
    allowInstanceControl?: boolean;
    /** Allow adding and deleting instances and upgrading adapters from the repository (default: false). */
    allowAdapterManagement?: boolean;
    /**
     * Allow the `install_package` tool, which installs an adapter package (npm, GitHub, URL or `.tgz`)
     * on an ioBroker host (default: false). Only relevant for adapter developers.
     */
    allowPackageInstall?: boolean;
    /** Allow creating, changing, deleting and running scripts of the javascript adapter (default: false). */
    allowScriptChange?: boolean;
    /**
     * Adapters (`telegram`) or instances (`telegram.0`) the `send_to` tool may send messages to, separated by
     * commas; `*` allows all. Empty (default): no `send_to` tool.
     */
    sendToAllowlist?: string;
    /**
     * Ask the user in the MCP client for a confirmation before dangerous actions, if the client supports
     * elicitation (default: true).
     */
    confirmDangerous?: boolean;
    /**
     * Let tools hand out short-lived download and upload links (`<mcp>/transfer/<token>`) for data that is
     * too large for a tool result or argument, e.g. a big object list or a .tgz to install (default: true).
     * Useful for clients that can run shell commands, e.g. Claude Code.
     */
    transferLinks?: boolean;
    certPublic: string;
    certPrivate: string;
    certChained: string;
    defaultUser?: `system.user.${string}`;
    certificates?: ioBroker.Certificates;
    leConfig?: boolean;
}

/** The permission toggles, which embedders (e.g. ioBroker.admin) can set without an mcp instance config. */
export type McpPermissions = Pick<
    McpConfig,
    | 'allowSetState'
    | 'setStateDestructive'
    | 'allowObjectChange'
    | 'allowInstanceControl'
    | 'allowAdapterManagement'
    | 'allowPackageInstall'
    | 'allowScriptChange'
    | 'sendToAllowlist'
    | 'confirmDangerous'
    | 'transferLinks'
>;

/** All keys of {@link McpPermissions}. */
export const PERMISSION_KEYS: (keyof McpPermissions)[] = [
    'allowSetState',
    'setStateDestructive',
    'allowObjectChange',
    'allowInstanceControl',
    'allowAdapterManagement',
    'allowPackageInstall',
    'allowScriptChange',
    'sendToAllowlist',
    'confirmDangerous',
    'transferLinks',
];
