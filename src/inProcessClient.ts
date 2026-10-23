/**
 * In-process MCP connection for embedding the ioBroker MCP server inside another adapter
 * (e.g. ioBroker.admin's chat helper) without an HTTP transport.
 *
 * The MCP SDK `Client` and `Server` are linked over an in-memory transport that lives entirely
 * in this module. The public {@link InProcessMcp} facade intentionally exposes only plain,
 * SDK-free shapes so consumers can depend on `iobroker.mcp` without resolving the MCP SDK's
 * subpath types themselves (important for consumers using classic `node` module resolution).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import McpServer from './index';

/** MCP tool behaviour hints, in a plain (SDK-free) shape. */
export interface InProcessToolAnnotations {
    /** Human-readable display name. */
    title?: string;
    /** The tool only reads; it never changes its environment. */
    readOnlyHint?: boolean;
    /** The tool may overwrite or remove existing data (only meaningful when `readOnlyHint` is false). */
    destructiveHint?: boolean;
    /** Calling the tool again with the same arguments has no additional effect. */
    idempotentHint?: boolean;
    /** The tool talks to entities outside of ioBroker (e.g. the network). */
    openWorldHint?: boolean;
}

/** A tool exposed by the in-process MCP server, in a plain (SDK-free) shape. */
export interface InProcessToolInfo {
    /** Tool name, e.g. `list_devices`. */
    name: string;
    /** Human/LLM-readable description of what the tool does. */
    description?: string;
    /** JSON Schema (object schema) describing the tool's input arguments. */
    inputSchema: Record<string, unknown>;
    /** Human-readable display name, e.g. `List devices by room`. */
    title?: string;
    /**
     * Behaviour hints the server declares for this tool. Embedders can use them to decide whether a
     * tool needs a confirmation before it is called (`readOnlyHint: false` / `destructiveHint: true`).
     */
    annotations?: InProcessToolAnnotations;
}

/** Result of a tool call: the concatenated text content plus the error flag. */
export interface InProcessToolResult {
    /** Concatenated text of all text content blocks the tool returned. */
    text: string;
    /** True if the tool reported an error (the text then holds the error payload). */
    isError: boolean;
}

/** Options for {@link createInProcessMcp}. */
export interface InProcessMcpOptions {
    /** The host adapter the MCP server runs inside (its ACLs/connection are used for all calls). */
    adapter: ioBroker.Adapter;
    /** ioBroker user whose permissions every tool call runs with (default: `system.user.admin`). */
    defaultUser?: `system.user.${string}`;
    /** Language for localized output (rooms/devices/functions). */
    language?: ioBroker.Languages;
    /**
     * Allow the state-writing tools `set_state`/`set_states` (default: **true**).
     *
     * Writing states is what makes the server useful for controlling a smart home, so it is opt-out:
     * pass `false` explicitly to expose the reading tools only.
     */
    allowSetState?: boolean;
    /**
     * Declare `set_state`/`set_states` as destructive (`destructiveHint`) (default: **true**).
     *
     * Pass `false` to declare them as non-destructive writes; `readOnlyHint` stays `false` either way.
     */
    setStateDestructive?: boolean;
    /** Allow the object/file-changing tools (`create_state`, `set_object`, ...) (default: false). */
    allowObjectChange?: boolean;
    /** Allow starting/stopping/restarting instances and changing their log level (default: false). */
    allowInstanceControl?: boolean;
    /** Allow adding/deleting instances and upgrading adapters from the repository (default: false). */
    allowAdapterManagement?: boolean;
    /**
     * Allow the `install_package` tool, which installs adapter packages on a host (default: false).
     * Only relevant for adapter developers.
     */
    allowPackageInstall?: boolean;
    /** Allow creating/changing/deleting/running scripts of the javascript adapter (default: false). */
    allowScriptChange?: boolean;
    /** Adapters or instances `send_to` may address, comma separated, `*` for all (default: none, no tool). */
    sendToAllowlist?: string;
    /** Ask the user before dangerous actions if the client supports elicitation (default: true). */
    confirmDangerous?: boolean;
    /** Name reported to the server by the embedded client. */
    clientName?: string;
    /** Version reported to the server by the embedded client. */
    clientVersion?: string;
}

/** A ready-to-use in-process MCP connection: list tools, call them, and close everything. */
export interface InProcessMcp {
    /** List the available tools (already filtered by the configured permission toggles). */
    listTools(): Promise<InProcessToolInfo[]>;
    /** Call a tool by name with the given arguments; returns its text result. */
    callTool(name: string, args?: Record<string, unknown>): Promise<InProcessToolResult>;
    /** Disconnect the client and server and release the host adapter's log listener. */
    close(): Promise<void>;
}

/** Content block shape returned by the MCP SDK for a tool call (only `text` blocks are used here). */
interface ToolContentBlock {
    type: string;
    text?: string;
}

/**
 * Create an in-process MCP server embedded in the given adapter and a linked client to drive it.
 *
 * @param options embedding options (host adapter, default user, language, permission toggles)
 * @returns a facade to list/call tools and to tear the connection down again
 */
export async function createInProcessMcp(options: InProcessMcpOptions): Promise<InProcessMcp> {
    const { clientName, clientVersion, ...embedOptions } = options;
    const mcp = McpServer.createEmbedded(embedOptions);

    const server = mcp.createInProcessServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
        {
            name: clientName || 'iobroker-inprocess-client',
            version: clientVersion || '1.0.0',
        },
        { capabilities: {} },
    );
    await client.connect(clientTransport);

    return {
        async listTools(): Promise<InProcessToolInfo[]> {
            const res = await client.listTools();
            return (res.tools || []).map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
                title: tool.title,
                annotations: tool.annotations,
            }));
        },
        async callTool(name: string, args?: Record<string, unknown>): Promise<InProcessToolResult> {
            const res = await client.callTool({ name, arguments: args || {} });
            const blocks = (res.content as ToolContentBlock[] | undefined) || [];
            const text = blocks
                .filter(block => block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text as string)
                .join('\n');
            return { text, isError: !!res.isError };
        },
        async close(): Promise<void> {
            try {
                await client.close();
            } catch {
                // ignore
            }
            try {
                await server.close();
            } catch {
                // ignore
            }
            mcp.unload();
        },
    };
}
