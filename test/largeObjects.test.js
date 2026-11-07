const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { startMcp, call, callOk } = require('./helpers');

/** Largest tool result the server sends, see MAX_RESULT_BYTES in src/index.ts */
const MAX_RESULT_BYTES = 900 * 1024;
const id = 'script.js.common.large';
/** 10 bytes, among them multibyte characters and the characters escaped on the wire */
const LINE = 'ä🙂\\"\r\n';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Size of a tool result in the JSON-RPC message, where its text is escaped once more */
const wireSize = text => Buffer.byteLength(JSON.stringify(text));

/** Call a tool and tell whether it was rejected, either by the input validation or by the tool itself. */
async function rejected(mcp, name, args) {
    try {
        return (await mcp.callTool(name, args)).isError === true;
    } catch {
        return true;
    }
}

/**
 * Read an object in parts as a client that can run code does: every part must fit into a tool result, the parts
 * must follow each other without gap or overlap, and the joined bytes must have the SHA-256 of the first part.
 */
async function readObjectInParts(mcp, objectId, length) {
    const parts = [];
    let first;
    let offset = 0;
    for (;;) {
        const args = {
            id: objectId,
            offset,
            ...(length ? { length } : {}),
            ...(first ? { sha256: first.sha256 } : {}),
        };
        const result = await call(mcp, 'get_object', args);
        assert.notEqual(result.isError, true, result.text);
        assert.ok(wireSize(result.text) <= MAX_RESULT_BYTES, `the part at ${offset} is too large`);
        const part = result.json.data;
        first = first || part;
        assert.equal(part.id, objectId);
        assert.equal(part.encoding, 'base64');
        assert.equal(part.offset, offset);
        assert.equal(part.size, first.size);
        assert.equal(part.sha256, first.sha256);
        const bytes = Buffer.from(part.content, 'base64');
        assert.equal(bytes.length, part.length);
        assert.ok(bytes.length > 0);
        parts.push(bytes);
        offset += bytes.length;
        if (!part.truncated) {
            assert.equal(part.nextOffset, undefined);
            break;
        }
        assert.equal(part.nextOffset, offset);
    }
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, first.size);
    assert.equal(sha256(bytes), first.sha256);
    return { bytes, parts: parts.length };
}

/** Read a script source in parts, checking that every part fits into a tool result and holds whole characters. */
async function readSourceInParts(mcp, scriptId, length) {
    const parts = [];
    let offset = 0;
    for (;;) {
        const result = await call(mcp, 'get_script', { id: scriptId, offset, ...(length ? { length } : {}) });
        assert.notEqual(result.isError, true, result.text);
        assert.ok(wireSize(result.text) <= MAX_RESULT_BYTES, `the part at ${offset} is too large`);
        const part = result.json.data;
        assert.equal(part.id, scriptId);
        assert.equal(part.offset, offset);
        // A split character would come back as U+FFFD with another byte length
        assert.equal(Buffer.byteLength(part.source), part.length);
        parts.push(part.source);
        offset += part.length;
        if (!part.truncated) {
            assert.equal(part.nextOffset, undefined);
            assert.equal(offset, part.size);
            break;
        }
        assert.equal(part.nextOffset, offset);
    }
    return parts;
}

describe('large objects and scripts', () => {
    let ctx;

    beforeEach(async () => {
        // Without links, a result above the limit fails instead of being replaced by a download link
        ctx = await startMcp({ defaultUser: 'system.user.reader', transferLinks: false });
        ctx.objects[id] = {
            _id: id,
            type: 'script',
            common: { name: 'large', engineType: 'Javascript/js', source: LINE.repeat(30) },
            native: {},
        };
    });
    afterEach(async () => ctx.mcp.close());

    describe('get_object', () => {
        it('returns the object, or null, without offset', async () => {
            assert.deepEqual((await callOk(ctx.mcp, 'get_object', { id })).object, ctx.objects[id]);
            assert.equal((await callOk(ctx.mcp, 'get_object', { id: 'absent' })).object, null);
        });

        it('returns an object too large for one answer in parts, read with the rights of the user', async () => {
            ctx.objects[id].common.source = LINE.repeat(400_000);
            const expected = Buffer.from(JSON.stringify(ctx.objects[id]));
            assert.ok(expected.length > 4 * 1024 * 1024);

            const whole = await call(ctx.mcp, 'get_object', { id });
            assert.equal(whole.isError, true);
            assert.match(whole.json.error, /larger than 900 KB/);

            const users = [];
            const get = ctx.adapter.getForeignObjectAsync;
            ctx.adapter.getForeignObjectAsync = (objectId, options) => {
                users.push(options && options.user);
                return get(objectId, options);
            };
            const { bytes, parts } = await readObjectInParts(ctx.mcp, id);
            assert.ok(bytes.equals(expected));
            assert.ok(parts > 1);
            assert.equal(users.length, parts);
            assert.ok(users.every(user => user === 'system.user.reader'));
        });

        it('honours a smaller length', async () => {
            const { bytes, parts } = await readObjectInParts(ctx.mcp, id, 64);
            assert.ok(bytes.equals(Buffer.from(JSON.stringify(ctx.objects[id]))));
            assert.equal(parts, Math.ceil(bytes.length / 64));
        });

        it('rejects invalid arguments and a missing object', async () => {
            for (const args of [
                { offset: -1 },
                { offset: 0.5 },
                { offset: 0, length: 0 },
                { offset: 0, length: 512 * 1024 + 1 },
                { length: 1 },
                { sha256: 'a'.repeat(64) },
                { offset: 1 },
                { offset: 0, sha256: 'invalid' },
                { offset: 0, sha256: 'a'.repeat(64) },
                { offset: 1_000_000, sha256: sha256(Buffer.from(JSON.stringify(ctx.objects[id]))) },
            ]) {
                assert.equal(await rejected(ctx.mcp, 'get_object', { id, ...args }), true, JSON.stringify(args));
            }
            const missing = await call(ctx.mcp, 'get_object', { id: 'absent', offset: 0 });
            assert.equal(missing.isError, true);
            assert.match(missing.json.error, /not found/);
        });

        for (const change of ['source', 'metadata', 'delete', 'acl']) {
            it(`fails when the object changes between the parts (${change})`, async () => {
                const first = await callOk(ctx.mcp, 'get_object', { id, offset: 0, length: 64 });
                assert.equal(first.truncated, true);
                if (change === 'source') {
                    ctx.objects[id].common.source = ctx.objects[id].common.source.replace('ä', 'ö');
                } else if (change === 'metadata') {
                    ctx.objects[id].native.changed = true;
                } else if (change === 'delete') {
                    delete ctx.objects[id];
                } else {
                    ctx.objects[id].acl = {
                        owner: 'system.user.admin',
                        ownerGroup: 'system.group.administrator',
                        object: 0x600,
                    };
                }
                const next = await call(ctx.mcp, 'get_object', { id, offset: first.nextOffset, sha256: first.sha256 });
                assert.equal(next.isError, true);
                assert.match(next.json.error, change === 'acl' ? /permissionError/ : /changed|not found/);
            });
        }
    });

    describe('get_script', () => {
        it('returns the whole source without offset', async () => {
            const data = await callOk(ctx.mcp, 'get_script', { id });
            assert.equal(data.source, LINE.repeat(30));
            assert.equal(data.truncated, undefined);
            assert.equal(data.size, undefined);
        });

        it('returns a source too long for one answer in parts without splitting characters', async () => {
            const source = LINE.repeat(400_000);
            ctx.objects[id].common.source = source;
            const whole = await call(ctx.mcp, 'get_script', { id });
            assert.equal(whole.isError, true);

            const parts = await readSourceInParts(ctx.mcp, id);
            assert.ok(parts.length > 1);
            assert.equal(parts.join(''), source);
        });

        it('keeps a part below the limit when every character is escaped twice', async () => {
            ctx.objects[id].common.source = '"'.repeat(2 * 1024 * 1024);
            const first = await call(ctx.mcp, 'get_script', { id, offset: 0 });
            assert.notEqual(first.isError, true, first.text);
            assert.ok(wireSize(first.text) <= MAX_RESULT_BYTES);
            assert.equal(first.json.data.truncated, true);
            assert.ok(first.json.data.length > 100 * 1024);
        });

        it('honours a smaller length and moves the edges to character boundaries', async () => {
            const parts = await readSourceInParts(ctx.mcp, id, 3);
            assert.equal(parts.join(''), LINE.repeat(30));
            // The 4-byte emoji does not fit into 3 bytes, but is returned whole
            assert.ok(parts.includes('🙂'));
        });

        it('returns an empty part behind the end of the source', async () => {
            const data = await callOk(ctx.mcp, 'get_script', { id, offset: 1_000_000 });
            assert.equal(data.source, '');
            assert.equal(data.truncated, false);
            assert.equal(data.size, Buffer.byteLength(LINE.repeat(30)));
        });
    });
});
