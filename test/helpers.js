/** Shared helpers for the MCP tool tests. */
const { createInProcessMcp } = require('../build/index.js');
const { createMockAdapter } = require('./mockAdapter');

/**
 * Start an in-process MCP server on top of a fresh mock adapter.
 *
 * @param options overrides for `createInProcessMcp` (by default every tool is enabled)
 * @returns the connection plus the mock's in-memory stores
 */
async function startMcp(options = {}) {
    const mock = createMockAdapter();
    const mcp = await createInProcessMcp({
        adapter: mock.adapter,
        language: 'en',
        allowSetState: true,
        allowObjectChange: true,
        allowPackageInstall: true,
        allowInstanceControl: true,
        allowAdapterManagement: true,
        allowScriptChange: true,
        sendToAllowlist: 'telegram, backitup.0',
        clientName: 'mcp-test-client',
        ...options,
    });
    return { ...mock, mcp };
}

/**
 * Start an in-process MCP server without passing any permission option, so the documented defaults
 * apply: state writing is opt-out (on), object/file changing and package installation are opt-in (off).
 *
 * @returns the connection plus the mock's in-memory stores
 */
async function startMcpWithDefaults() {
    const mock = createMockAdapter();
    const mcp = await createInProcessMcp({ adapter: mock.adapter });
    return { ...mock, mcp };
}

/**
 * Call a tool and parse its JSON payload.
 *
 * @param mcp the connection returned by {@link startMcp}
 * @param name tool name
 * @param args tool arguments
 * @returns `{ isError, text, json }` where `json` is the parsed tool result
 */
async function call(mcp, name, args) {
    const result = await mcp.callTool(name, args);
    let json;
    try {
        json = JSON.parse(result.text);
    } catch {
        throw new Error(`Tool "${name}" did not return JSON: ${result.text}`);
    }
    return { isError: result.isError, text: result.text, json };
}

/**
 * Call a tool and assert it succeeded, returning its `data` payload.
 *
 * @param mcp the connection returned by {@link startMcp}
 * @param name tool name
 * @param args tool arguments
 * @returns the `data` property of the tool result
 */
async function callOk(mcp, name, args) {
    const result = await call(mcp, name, args);
    if (result.isError || result.json.ok !== true) {
        throw new Error(`Tool "${name}" failed: ${result.text}`);
    }
    return result.json.data;
}

module.exports = { startMcp, startMcpWithDefaults, call, callOk };
