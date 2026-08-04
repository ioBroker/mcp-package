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
    /** Allow the `set_state`/`set_states` tools to write states (default: true). */
    allowSetState: boolean;
    /** Allow the object/file changing tools (`set_object`, `delete_object`, `create_state`, `create_scene`, `write_file`, `delete_file`, `rename_file`, `mkdir`) (default: false). */
    allowObjectChange: boolean;
    certPublic: string;
    certPrivate: string;
    certChained: string;
    defaultUser?: `system.user.${string}`;
    certificates?: ioBroker.Certificates;
    leConfig?: boolean;
}
