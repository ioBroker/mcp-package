/**
 * Contract tests for what the server advertises in `tools/list`.
 *
 * MCP hosts (and the public MCP directories) reject or downgrade servers whose tools lack a
 * description, an input schema or the four behaviour hints, so those are asserted for every tool.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startMcp, startMcpWithDefaults } = require('./helpers');

/** Every tool the server registers when all permission toggles are on. */
const ALL_TOOLS = [
    'create_scene',
    'create_state',
    'delete_file',
    'delete_object',
    'file_exists',
    'get_logs',
    'get_object',
    'get_states',
    'history_query',
    'install_package',
    'list_adapters',
    'list_devices',
    'list_files',
    'list_functions',
    'list_hosts',
    'list_instances',
    'list_rooms',
    'mkdir',
    'ping_host',
    'read_file',
    'rename_file',
    'search_adapter_repository',
    'search_objects',
    'set_object',
    'set_state',
    'set_states',
    'system_info',
    'write_file',
    'write_log',
];

/** Tools gated behind `allowSetState`. */
const STATE_WRITE_TOOLS = ['set_state', 'set_states'];

/** Tools gated behind `allowObjectChange`. */
const OBJECT_CHANGE_TOOLS = [
    'set_object',
    'delete_object',
    'create_state',
    'create_scene',
    'write_file',
    'delete_file',
    'rename_file',
    'mkdir',
];

/** Tools gated behind `allowPackageInstall`. */
const PACKAGE_INSTALL_TOOLS = ['install_package'];

/** Tools that must not modify anything. */
const READ_ONLY_TOOLS = [
    'get_states',
    'get_logs',
    'ping_host',
    'system_info',
    'search_objects',
    'list_devices',
    'history_query',
    'list_instances',
    'list_hosts',
    'list_adapters',
    'search_adapter_repository',
    'list_rooms',
    'list_functions',
    'get_object',
    'read_file',
    'list_files',
    'file_exists',
];

describe('tool metadata', () => {
    let mcp;
    let tools;

    before(async () => {
        ({ mcp } = await startMcp());
        tools = await mcp.listTools();
    });

    after(async () => {
        await mcp.close();
    });

    it('registers exactly the documented set of tools', () => {
        assert.deepEqual(
            tools.map(tool => tool.name).sort(),
            ALL_TOOLS.slice().sort(),
            'the advertised tools drifted from the documented list',
        );
    });

    it('gives every tool a title and a non-trivial description', () => {
        for (const tool of tools) {
            assert.ok(tool.title && tool.title.length > 2, `${tool.name}: missing title`);
            assert.ok(
                tool.description && tool.description.length > 20,
                `${tool.name}: missing or too short description`,
            );
        }
    });

    it('declares an object input schema for every tool', () => {
        for (const tool of tools) {
            assert.ok(tool.inputSchema, `${tool.name}: no inputSchema`);
            assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema is not an object schema`);
            assert.ok(tool.inputSchema.properties, `${tool.name}: inputSchema has no properties`);
        }
    });

    it('declares all four behaviour hints as booleans on every tool', () => {
        const hints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
        for (const tool of tools) {
            assert.ok(tool.annotations, `${tool.name}: no annotations`);
            for (const hint of hints) {
                assert.equal(
                    typeof tool.annotations[hint],
                    'boolean',
                    `${tool.name}: ${hint} is ${JSON.stringify(tool.annotations[hint])}, expected a boolean`,
                );
            }
        }
    });

    it('marks the reading tools read-only and the writing tools not', () => {
        const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
        for (const name of READ_ONLY_TOOLS) {
            assert.equal(byName[name].annotations.readOnlyHint, true, `${name} should be read-only`);
            assert.equal(byName[name].annotations.destructiveHint, false, `${name} must not be destructive`);
        }
        for (const name of [...STATE_WRITE_TOOLS, ...OBJECT_CHANGE_TOOLS, ...PACKAGE_INSTALL_TOOLS, 'write_log']) {
            assert.equal(byName[name].annotations.readOnlyHint, false, `${name} must not be read-only`);
        }
    });

    it('flags only ping_host and install_package as talking to the outside world', () => {
        for (const tool of tools) {
            assert.equal(
                tool.annotations.openWorldHint,
                tool.name === 'ping_host' || tool.name === 'install_package',
                `${tool.name}: unexpected openWorldHint`,
            );
        }
    });

    it('is exercised by the functional test suite - every tool is called there', () => {
        const source = fs.readFileSync(path.join(__dirname, 'tools.test.js'), 'utf8');
        for (const name of ALL_TOOLS) {
            assert.ok(source.includes(`'${name}'`), `${name} is declared but never called in tools.test.js`);
        }
    });

    it('offers state writing by default and keeps object changing opt-in', async () => {
        const { mcp: defaults } = await startMcpWithDefaults();
        try {
            const names = (await defaults.listTools()).map(tool => tool.name);
            for (const name of STATE_WRITE_TOOLS) {
                assert.ok(names.includes(name), `${name} must be offered by default - allowSetState is opt-out`);
            }
            for (const name of OBJECT_CHANGE_TOOLS) {
                assert.ok(!names.includes(name), `${name} must stay off by default - allowObjectChange is opt-in`);
            }
            for (const name of PACKAGE_INSTALL_TOOLS) {
                assert.ok(!names.includes(name), `${name} must stay off by default - allowPackageInstall is opt-in`);
            }
        } finally {
            await defaults.close();
        }
    });

    it('hides the state-writing tools when allowSetState is off', async () => {
        const { mcp: limited } = await startMcp({ allowSetState: false });
        try {
            const names = (await limited.listTools()).map(tool => tool.name);
            for (const name of STATE_WRITE_TOOLS) {
                assert.ok(!names.includes(name), `${name} must not be offered when allowSetState is off`);
            }
            assert.ok(names.includes('get_states'), 'reading tools stay available');
        } finally {
            await limited.close();
        }
    });

    it('declares the state-writing tools destructive by default', () => {
        const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
        for (const name of STATE_WRITE_TOOLS) {
            assert.equal(byName[name].annotations.destructiveHint, true, `${name} must be destructive by default`);
        }
    });

    it('declares the state-writing tools non-destructive when setStateDestructive is off', async () => {
        const { mcp: relaxed } = await startMcp({ setStateDestructive: false });
        try {
            const byName = Object.fromEntries((await relaxed.listTools()).map(tool => [tool.name, tool]));
            for (const name of STATE_WRITE_TOOLS) {
                assert.equal(byName[name].annotations.destructiveHint, false, `${name} must not be destructive`);
                assert.equal(byName[name].annotations.readOnlyHint, false, `${name} still writes`);
            }
        } finally {
            await relaxed.close();
        }
    });

    it('hides the object/file changing tools when allowObjectChange is off', async () => {
        const { mcp: limited } = await startMcp({ allowObjectChange: false });
        try {
            const names = (await limited.listTools()).map(tool => tool.name);
            for (const name of OBJECT_CHANGE_TOOLS) {
                assert.ok(!names.includes(name), `${name} must not be offered when allowObjectChange is off`);
            }
            assert.ok(names.includes('get_object'), 'reading tools stay available');
        } finally {
            await limited.close();
        }
    });
    it('hides install_package when allowPackageInstall is off', async () => {
        const { mcp: limited } = await startMcp({ allowPackageInstall: false });
        try {
            const names = (await limited.listTools()).map(tool => tool.name);
            for (const name of PACKAGE_INSTALL_TOOLS) {
                assert.ok(!names.includes(name), `${name} must not be offered when allowPackageInstall is off`);
            }
            assert.ok(names.includes('set_object'), 'the other tools stay available');
        } finally {
            await limited.close();
        }
    });

    /**
     * Both assertions below guard against a split zod installation. The MCP SDK converts and
     * re-wraps the registered schemas with the zod copy from its own dependency tree, which is
     * not necessarily the copy this package built them with. Two constructs do not survive that:
     *
     *   z.record(...)            -> its JSON Schema processor pushes onto a context field that
     *                               only newer zod versions create, so tools/list throws
     *                               "Cannot read properties of undefined (reading 'push')" and
     *                               the client ends up without any tool at all.
     *   top-level z.default(...) -> the SDK's object parser does not recognise a foreign
     *                               ZodDefault, treats the key as required and answers a call
     *                               that omits it with "expected nonoptional".
     *
     * Neither is visible in a deduplicated dev install, hence these contract tests on the
     * advertised schema: `propertyNames` is what a record emits, `default` what z.default() emits.
     */
    it('advertises no record-derived schema, which breaks across zod versions', () => {
        for (const tool of tools) {
            const found = [];
            const walk = (node, path) => {
                if (!node || typeof node !== 'object') {
                    return;
                }
                if (Object.prototype.hasOwnProperty.call(node, 'propertyNames')) {
                    found.push(path || '<root>');
                }
                for (const [key, value] of Object.entries(node)) {
                    walk(value, path ? `${path}.${key}` : key);
                }
            };
            walk(tool.inputSchema, '');
            assert.deepEqual(
                found,
                [],
                `${tool.name}: use z.looseObject({}) instead of z.record() at ${found.join(', ')}`,
            );
        }
    });

    it('advertises no default on a top-level argument, which breaks across zod versions', () => {
        for (const tool of tools) {
            const properties = tool.inputSchema.properties || {};
            for (const [name, schema] of Object.entries(properties)) {
                assert.ok(
                    !Object.prototype.hasOwnProperty.call(schema, 'default'),
                    `${tool.name}.${name}: make it .optional() and apply the default in the handler`,
                );
            }
        }
    });
});
