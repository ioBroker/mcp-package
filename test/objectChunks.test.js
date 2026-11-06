const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { startMcp, call, callOk } = require('./helpers');
const { readObjectChunks } = require('../examples/read-object-chunks');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = 'script.js.Dashboard.Tradepilot_Dashboard';

describe('get_object chunked reads (read-only)', () => {
    let ctx;
    const invoke = async args => {
        const result = await ctx.mcp.callTool('get_object', args);
        return { isError: result.isError, content: [{ type: 'text', text: result.text }] };
    };
    const smallChunks = args => invoke({ ...args, length: 64 });

    beforeEach(async () => {
        ctx = await startMcp({
            defaultUser: 'system.user.reader',
            allowSetState: false,
            allowObjectChange: false,
            allowScriptChange: false,
            allowPackageInstall: false,
            allowInstanceControl: false,
            allowAdapterManagement: false,
            sendToAllowlist: '',
            transferLinks: false,
        });
        ctx.objects[id] = { _id: id, type: 'script', common: { source: 'ä🙂\\\"\r\n'.repeat(30) }, native: {} };
    });
    afterEach(async () => ctx.mcp.close());

    it('preserves the unpaged object/null contract', async () => {
        assert.deepEqual((await callOk(ctx.mcp, 'get_object', { id })).object, ctx.objects[id]);
        assert.equal((await callOk(ctx.mcp, 'get_object', { id: 'absent' })).object, null);
    });

    it('reads a multi-megabyte script byte-for-byte with the original wire limit and per-chunk user', async () => {
        const source = process.env.MCP_LARGE_SOURCE_FILE
            ? fs.readFileSync(process.env.MCP_LARGE_SOURCE_FILE)
            : Buffer.from('ä🙂\\\"\r\n'.repeat(400000));
        if (process.env.MCP_LARGE_SOURCE_SHA256) {
            assert.equal(hash(source), process.env.MCP_LARGE_SOURCE_SHA256, 'independent PRIMARY fixture pin');
        }
        assert.ok(source.length > 3 * 1024 * 1024);
        ctx.objects[id].common.source = source.toString('utf8');
        const expected = Buffer.from(JSON.stringify(ctx.objects[id]));
        const get = ctx.adapter.getForeignObjectAsync;
        const users = [];
        ctx.adapter.getForeignObjectAsync = async (objectId, options) => {
            users.push(options.user);
            return get(objectId, options);
        };
        const legacy = await call(ctx.mcp, 'get_object', { id });
        assert.equal(legacy.isError, true, 'reproduces oversized unpaged response');
        assert.match(legacy.json.error, /larger than 900 KB/);
        users.length = 0;
        let maxWireBytes = 0;
        const result = await readObjectChunks(
            async args => {
                const page = await invoke(args);
                const wireBytes = Buffer.byteLength(JSON.stringify(page.content[0].text));
                maxWireBytes = Math.max(wireBytes, maxWireBytes);
                assert.ok(wireBytes <= 900 * 1024);
                return page;
            },
            id,
            { expectedSource: source },
        );
        assert.ok(result.bytes.equals(expected));
        assert.ok(result.sourceBytes.equals(source));
        assert.equal(result.sha256, hash(expected));
        assert.equal(result.sourceSha256, hash(source));
        assert.equal(users.length, result.chunks);
        assert.ok(users.every(user => user === 'system.user.reader'));
        console.log(
            JSON.stringify({
                sourceBytes: source.length,
                sourceSha256: result.sourceSha256,
                objectBytes: result.bytes.length,
                objectSha256: result.sha256,
                chunks: result.chunks,
                maxWireBytes,
            }),
        );
    });

    it('rejects invalid ranges, missing continuation pins, malformed hashes and missing objects', async () => {
        for (const args of [
            { offset: -1 },
            { offset: 0.5 },
            { offset: Number.MAX_SAFE_INTEGER + 1 },
            { offset: 0, length: 0 },
            { offset: 0, length: 524289 },
            { length: 1 },
            { offset: 1 },
            { offset: 0, sha256: 'invalid' },
            { sha256: 'a'.repeat(64) },
            { offset: Number.MAX_SAFE_INTEGER, sha256: 'a'.repeat(64) },
        ]) {
            let rejected = false;
            try {
                rejected = (await invoke({ id, ...args })).isError === true;
            } catch {
                rejected = true;
            }
            assert.equal(rejected, true, JSON.stringify(args));
        }
        assert.equal((await invoke({ id: 'absent', offset: 0 })).isError, true);
    });

    for (const mutation of ['source', 'metadata', 'delete', 'acl']) {
        it(`rejects ${mutation} changes between chunks`, async () => {
            const first = await callOk(ctx.mcp, 'get_object', { id, offset: 0, length: 64 });
            if (mutation === 'source') ctx.objects[id].common.source = ctx.objects[id].common.source.replace('ä', 'ö');
            if (mutation === 'metadata') ctx.objects[id].native.changed = true;
            if (mutation === 'delete') delete ctx.objects[id];
            if (mutation === 'acl')
                ctx.objects[id].acl = {
                    owner: 'system.user.admin',
                    ownerGroup: 'system.group.administrator',
                    object: 0x600,
                };
            const next = await call(ctx.mcp, 'get_object', { id, offset: first.nextOffset, sha256: first.sha256 });
            assert.equal(next.isError, true);
            assert.match(next.json.error, mutation === 'acl' ? /permissionError/ : /changed|not found/);
        });
    }

    const corruptions = {
        'changed content': page => {
            page.content = Buffer.alloc(page.length, 65).toString('base64');
        },
        'early end': page => {
            page.truncated = false;
            delete page.nextOffset;
        },
        'missing block': page => {
            page.offset += 64;
        },
        'overlapping block': page => {
            page.nextOffset -= 1;
        },
        'zero progress': page => {
            page.length = 0;
            page.content = '';
        },
        'wrong size': page => {
            page.size += 1;
        },
        'wrong identity': page => {
            page.id = 'other';
        },
        'missing hash': page => {
            delete page.sha256;
        },
        'noncanonical base64': page => {
            page.content += '\n';
        },
        'missing content bytes': page => {
            page.content = '';
        },
    };
    for (const [name, corrupt] of Object.entries(corruptions)) {
        it(`client refuses ${name}`, async () => {
            let calls = 0;
            await assert.rejects(
                readObjectChunks(async args => {
                    const result = await smallChunks(args);
                    const envelope = JSON.parse(result.content[0].text);
                    if (++calls === 2) corrupt(envelope.data);
                    result.content[0].text = JSON.stringify(envelope);
                    return result;
                }, id),
            );
        });
    }

    it('client refuses a lost final response', async () => {
        let calls = 0;
        await assert.rejects(
            readObjectChunks(args => {
                if (++calls === 2) throw new Error('connection closed');
                return smallChunks(args);
            }, id),
            /connection closed/,
        );
    });

    it('client refuses wrong PRIMARY bytes after a valid complete read', async () => {
        await assert.rejects(
            readObjectChunks(smallChunks, id, { expectedSource: Buffer.from('different') }),
            /PRIMARY/,
        );
    });
});
