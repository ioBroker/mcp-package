/** Tests of the download and upload links (`<mcp>/transfer/<token>`), which need the HTTP server. */
const assert = require('node:assert/strict');
const express = require('express');
const { McpServer } = require('../build/index.js');
const { createMockAdapter } = require('./mockAdapter');

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-test-client', version: '1.0.0' },
    },
};

/**
 * Start a standalone MCP server on a random port.
 *
 * @param config adapter config on top of the defaults
 * @returns the mock, the server and the URL of the MCP endpoint
 */
async function startHttp(config = {}) {
    const mock = createMockAdapter();
    mock.adapter.config = { bind: '127.0.0.1', allowObjectChange: true, allowPackageInstall: true, ...config };
    const app = express();
    const mcpServer = new McpServer(null, {}, mock.adapter, null, app);
    const httpServer = await new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
    let id = 1;

    async function post(sessionId, body) {
        const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
        if (sessionId) {
            headers['mcp-session-id'] = sessionId;
        }
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        return {
            status: response.status,
            sessionId: response.headers.get('mcp-session-id'),
            text: await response.text(),
        };
    }

    const init = await post(undefined, INITIALIZE);
    assert.equal(init.status, 200, init.text);
    const sessionId = init.sessionId;
    await post(sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' });

    /** Send a JSON-RPC request and return its result (the answer comes as a server-sent event). */
    async function request(method, params) {
        const answer = await post(sessionId, { jsonrpc: '2.0', id: ++id, method, params });
        assert.equal(answer.status, 200, answer.text);
        const line = answer.text.split('\n').find(one => one.startsWith('data: '));
        return JSON.parse(line.substring(6)).result;
    }

    return {
        ...mock,
        url,
        async listTools() {
            return (await request('tools/list', {})).tools.map(tool => tool.name);
        },
        /** Call a tool and return `{ isError, json }`. */
        async call(name, args) {
            const result = await request('tools/call', { name, arguments: args });
            return { isError: !!result.isError, json: JSON.parse(result.content[0].text) };
        },
        async close() {
            mcpServer.unload();
            httpServer.closeAllConnections();
            await new Promise(resolve => httpServer.close(resolve));
        },
    };
}

describe('download and upload links', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startHttp();
    });

    afterEach(async () => {
        await ctx.close();
    });

    it('read_file with download returns a link to the whole file', async () => {
        const { isError, json } = await ctx.call('read_file', {
            path: '0_userdata.0/folder/test.json',
            download: true,
        });
        assert.equal(isError, false, JSON.stringify(json));
        assert.ok(json.data.download_url.startsWith(`${ctx.url}/transfer/`), json.data.download_url);
        assert.equal(json.data.size, 17);

        const response = await fetch(json.data.download_url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-disposition'), /filename="test.json"/);
        assert.equal(await response.text(), '{"hello":"world"}');
    });

    it('offers all entries of a cut list as a download', async () => {
        for (let i = 0; i < 1500; i++) {
            const id = `big.0.state${i}`;
            ctx.objects[id] = { _id: id, type: 'state', common: { name: `Big ${'x'.repeat(1000)}` }, native: {} };
        }
        const { json } = await ctx.call('search_objects', { query: 'big.0.', limit: 9999 });
        assert.equal(json.data.truncated, true);
        assert.ok(json.data.download_url, JSON.stringify(json.data).substring(0, 300));

        const all = await (await fetch(json.data.download_url)).json();
        assert.equal(all.length, 1500);
    });

    it('hands out a link instead of a result that is too large', async () => {
        ctx.objects['big.0.huge'] = {
            _id: 'big.0.huge',
            type: 'state',
            common: {},
            native: { blob: 'x'.repeat(2_000_000) },
        };
        const { isError, json } = await ctx.call('get_object', { id: 'big.0.huge' });
        assert.equal(isError, false);
        assert.equal(json.too_large, true);
        const result = await (await fetch(json.download_url)).json();
        assert.equal(result.data.object.native.blob.length, 2_000_000);
    });

    it('answers unknown links with 404', async () => {
        assert.equal((await fetch(`${ctx.url}/transfer/unknown`)).status, 404);
        assert.equal((await fetch(`${ctx.url}/transfer/unknown`, { method: 'PUT', body: 'x' })).status, 404);
    });

    it('writes an uploaded file with write_file', async () => {
        const { json } = await ctx.call('prepare_upload', { name: 'data.bin' });
        const { upload_id, url, method, command } = json.data;
        assert.equal(method, 'PUT');
        assert.match(command, /^curl -T "data.bin" "http/);

        // Not uploaded yet
        const early = await ctx.call('write_file', { path: '0_userdata.0/folder/data.bin', upload_id });
        assert.match(early.json.error, /Nothing was uploaded/);
        // An upload link is no download link
        assert.equal((await fetch(url)).status, 404);

        const data = Buffer.from([0, 1, 2, 250, 251, 252]);
        const upload = await fetch(url, { method: 'PUT', body: data });
        assert.equal(upload.status, 200, await upload.clone().text());
        assert.deepEqual(await upload.json(), { ok: true, upload_id, name: 'data.bin', size: 6 });
        assert.equal((await fetch(url, { method: 'PUT', body: data })).status, 409);

        const written = await ctx.call('write_file', { path: '0_userdata.0/folder/data.bin', upload_id });
        assert.equal(written.isError, false, JSON.stringify(written.json));
        assert.deepEqual(ctx.files['0_userdata.0']['folder/data.bin'], data);

        // An upload is used once
        const again = await ctx.call('write_file', { path: '0_userdata.0/folder/data.bin', upload_id });
        assert.match(again.json.error, /Unknown or expired upload/);
    });

    it('installs an uploaded .tgz with install_package', async () => {
        const { json } = await ctx.call('prepare_upload', { name: 'iobroker.hue-3.9.1.tgz' });
        const upload = await fetch(json.data.url, { method: 'POST', body: 'tgz-data' });
        assert.equal(upload.status, 200);

        const installed = await ctx.call('install_package', { upload_id: json.data.upload_id });
        assert.equal(installed.isError, false, JSON.stringify(installed.json));
        assert.equal(ctx.cmdExec.sent[0].data, 'url iobroker.hue-3.9.1.tgz --host testhost');
        assert.deepEqual(ctx.cmdExec.sent[0].files, [
            { name: 'iobroker.hue-3.9.1.tgz', file: Buffer.from('tgz-data').toString('base64') },
        ]);
        assert.equal(installed.json.data.adapter, 'hue');
    });
});

describe('links turned off', () => {
    let ctx;

    before(async () => {
        ctx = await startHttp({ transferLinks: false });
    });

    after(async () => {
        await ctx.close();
    });

    it('has no prepare_upload and no download', async () => {
        const tools = await ctx.listTools();
        assert.ok(tools.includes('write_file'));
        assert.ok(!tools.includes('prepare_upload'));

        const { isError, json } = await ctx.call('read_file', {
            path: '0_userdata.0/folder/test.json',
            download: true,
        });
        assert.equal(isError, true);
        assert.match(json.error, /turned off/);
    });
});

describe('stale transfer folders', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    it('removes folders left behind by a killed process, but not fresh ones', async () => {
        const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'iobroker-mcp-'));
        fs.mkdirSync(path.join(stale, 'token'));
        fs.writeFileSync(path.join(stale, 'token', 'file.tgz'), 'x');
        const old = new Date(Date.now() - 20 * 60_000);
        fs.utimesSync(stale, old, old);
        const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'iobroker-mcp-'));

        const ctx = await startHttp();
        try {
            assert.equal(fs.existsSync(stale), false, 'the stale folder was kept');
            assert.equal(fs.existsSync(fresh), true, 'a fresh folder was removed');
        } finally {
            await ctx.close();
            fs.rmSync(fresh, { recursive: true, force: true });
        }
    });
});
