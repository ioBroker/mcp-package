/**
 * Functional tests: every declared tool is called through a real MCP client/server pair
 * (in-memory transport) on top of the mock adapter, and its result is verified.
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const { startMcp, call, callOk } = require('./helpers');

describe('reading tools', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('get_states returns the current values', async () => {
        const data = await callOk(ctx.mcp, 'get_states', { ids: ['hue.0.light.state', 'hue.0.light.brightness'] });
        assert.equal(data.states.length, 2);
        assert.equal(data.states[0].id, 'hue.0.light.state');
        assert.equal(data.states[0].value, false);
        assert.equal(data.states[1].value, 42);
    });

    it('get_states expands wildcards', async () => {
        const data = await callOk(ctx.mcp, 'get_states', { ids: ['hue.0.light.*'] });
        assert.deepEqual(data.states.map(state => state.id).sort(), ['hue.0.light.brightness', 'hue.0.light.state']);
    });

    it('get_states reports unknown ids instead of failing', async () => {
        const data = await callOk(ctx.mcp, 'get_states', { ids: ['does.not.0.exist'] });
        assert.equal(data.states.length, 1);
        assert.equal(data.states[0].value, null);
    });

    it('get_object reads an object and returns null for a missing one', async () => {
        const found = await callOk(ctx.mcp, 'get_object', { id: 'hue.0.light.state' });
        assert.equal(found.object._id, 'hue.0.light.state');
        assert.equal(found.object.common.role, 'switch.light');

        const missing = await callOk(ctx.mcp, 'get_object', { id: 'nope.0.nothing' });
        assert.equal(missing.object, null);
    });

    it('get_logs parses the host log and filters by level', async () => {
        const all = await callOk(ctx.mcp, 'get_logs', {});
        assert.equal(all.logs.length, 4);
        assert.equal(all.logs[0].level, 'error');
        assert.equal(all.logs[0].source, 'hm-rpc.0');
        assert.ok(all.logs[0].ts > 0);

        const errors = await callOk(ctx.mcp, 'get_logs', { level: ['error'] });
        assert.equal(errors.logs.length, 1);
        assert.equal(errors.logs[0].level, 'error');
    });

    it('get_logs filters by adapter', async () => {
        const data = await callOk(ctx.mcp, 'get_logs', { adapter: 'hue.0' });
        assert.equal(data.logs.length, 2);
        assert.ok(data.logs.every(entry => entry.source === 'hue.0'));
    });

    it('system_info reports the js-controller version and instance count', async () => {
        const data = await callOk(ctx.mcp, 'system_info', {});
        assert.equal(data.js_controller, '7.0.6');
        assert.equal(data.instances, 2);
        assert.ok(data.hostname);
        assert.ok(data.mem.total_mb > 0);
    });

    it('search_objects matches ids and names', async () => {
        const byName = await callOk(ctx.mcp, 'search_objects', { query: 'brightness' });
        assert.equal(byName.results.length, 1);
        assert.equal(byName.results[0].id, 'hue.0.light.brightness');
        assert.equal(byName.results[0].adapter, 'hue.0');

        const byType = await callOk(ctx.mcp, 'search_objects', { query: 'light', type: 'channel' });
        assert.deepEqual(
            byType.results.map(one => one.id),
            ['hue.0.light'],
        );
    });

    it('search_objects filters by room and by adapter', async () => {
        const byRoom = await callOk(ctx.mcp, 'search_objects', { query: '', room: 'Living room' });
        assert.deepEqual(
            byRoom.results.map(one => one.id),
            ['hue.0.light'],
        );

        const byAdapter = await callOk(ctx.mcp, 'search_objects', { query: '', adapter: 'hue.0' });
        assert.equal(byAdapter.results.length, 3);
    });

    it('search_objects honours the limit', async () => {
        const data = await callOk(ctx.mcp, 'search_objects', { query: '', limit: 2 });
        assert.equal(data.results.length, 2);
    });

    it('list_devices groups detected devices by room', async () => {
        const data = await callOk(ctx.mcp, 'list_devices', {});
        assert.equal(data.rooms.length, 1);
        assert.equal(data.rooms[0].roomName, 'Living room');

        const device = data.rooms[0].devicesInRoom[0];
        assert.equal(device.deviceName, 'Ceiling lamp');
        assert.equal(device.deviceType, 'dimmer');
        assert.equal(device.functionality, 'Light');
        assert.equal(device.controls.ON_SET.stateId, 'hue.0.light.state');
    });

    it('list_devices localizes names and filters by room', async () => {
        const german = await callOk(ctx.mcp, 'list_devices', { language: 'de' });
        assert.equal(german.rooms[0].roomName, 'Wohnzimmer');

        const filtered = await callOk(ctx.mcp, 'list_devices', { room: 'Kitchen' });
        assert.deepEqual(filtered.rooms, []);
    });

    it('history_query returns the recorded values', async () => {
        const data = await callOk(ctx.mcp, 'history_query', {
            id: 'hue.0.light.brightness',
            from: '2025-06-15T00:00:00Z',
            agg: 'avg',
            interval: '15m',
        });
        assert.equal(data.id, 'hue.0.light.brightness');
        assert.equal(data.values.length, 2);
        assert.equal(data.values[0].val, 20.5);
    });

    it('list_instances reports enabled/alive/connected', async () => {
        const data = await callOk(ctx.mcp, 'list_instances', {});
        const admin = data.instances.find(instance => instance.id === 'admin.0');
        assert.ok(admin, 'admin.0 missing');
        assert.equal(admin.enabled, true);
        assert.equal(admin.alive, true);
        assert.equal(admin.connected, true);
        assert.equal(admin.title, 'Admin');
    });

    it('list_hosts reports the host status', async () => {
        const data = await callOk(ctx.mcp, 'list_hosts', {});
        assert.equal(data.hosts.length, 1);
        assert.deepEqual(data.hosts[0], {
            id: 'testhost',
            alive: true,
            js_controller: '7.0.6',
            platform: 'linux',
        });
    });

    it('list_adapters lists what is installed', async () => {
        const data = await callOk(ctx.mcp, 'list_adapters', { language: 'en' });
        assert.equal(data.adapters.length, 1);
        assert.deepEqual(data.adapters[0], {
            name: 'admin',
            version: '7.4.10',
            title: 'Admin',
            description: 'The ioBroker administration UI',
            keywords: ['ui'],
            mode: 'daemon',
        });
    });

    it('search_adapter_repository finds installable adapters', async () => {
        const data = await callOk(ctx.mcp, 'search_adapter_repository', { query: 'hue' });
        assert.equal(data.adapters.length, 1);
        assert.equal(data.adapters[0].name, 'hue');
        assert.equal(data.adapters[0].title, 'Philips Hue');
        assert.equal(data.adapters[0].type, 'lighting');
        assert.equal(data.adapters[0].installed, false);
    });

    it('search_adapter_repository filters by type and skips meta keys', async () => {
        const data = await callOk(ctx.mcp, 'search_adapter_repository', { query: '', type: 'hardware' });
        assert.deepEqual(
            data.adapters.map(one => one.name),
            ['zigbee'],
        );

        const all = await callOk(ctx.mcp, 'search_adapter_repository', { query: '' });
        assert.ok(!all.adapters.some(one => one.name.startsWith('_')), 'repo meta keys leaked into the result');
    });

    it('list_rooms returns members with metadata', async () => {
        const data = await callOk(ctx.mcp, 'list_rooms', { language: 'en', withIcons: true });
        assert.equal(data.rooms.length, 1);
        assert.equal(data.rooms[0].id, 'enum.rooms.living_room');
        assert.equal(data.rooms[0].name, 'Living room');
        assert.equal(data.rooms[0].icon, 'room.png');
        assert.deepEqual(
            data.rooms[0].items.map(item => item.id),
            ['hue.0.light'],
        );
    });

    it('list_rooms omits icons unless asked and localizes', async () => {
        const data = await callOk(ctx.mcp, 'list_rooms', { language: 'de' });
        assert.equal(data.rooms[0].name, 'Wohnzimmer');
        assert.equal(data.rooms[0].icon, undefined);
    });

    it('list_functions returns the function enums', async () => {
        const data = await callOk(ctx.mcp, 'list_functions', { language: 'en' });
        assert.equal(data.functions.length, 1);
        assert.equal(data.functions[0].name, 'Light');
        assert.equal(data.functions[0].items[0].id, 'hue.0.light');
    });
});

describe('file tools', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('read_file returns the whole file when it fits', async () => {
        const data = await callOk(ctx.mcp, 'read_file', { path: '0_userdata.0/folder/test.json' });
        assert.equal(data.content, '{"hello":"world"}');
        assert.equal(data.encoding, 'utf8');
        assert.equal(data.size, 17);
        assert.equal(data.offset, 0);
        assert.equal(data.truncated, false);
        assert.equal(data.nextOffset, undefined);
    });

    it('read_file reads large files in chunks', async () => {
        const first = await callOk(ctx.mcp, 'read_file', { path: '0_userdata.0/folder/test.json', length: 8 });
        assert.equal(first.truncated, true);
        assert.equal(first.length, 8);
        assert.equal(first.nextOffset, 8);

        const second = await callOk(ctx.mcp, 'read_file', {
            path: '0_userdata.0/folder/test.json',
            offset: first.nextOffset,
        });
        assert.equal(second.truncated, false);
        assert.equal(`${first.content}${second.content}`, '{"hello":"world"}');
    });

    it('read_file never splits a multibyte character', async () => {
        // "äöü-Straße" - the chunk boundary at byte 3 falls inside a two-byte character.
        const chunk = await callOk(ctx.mcp, 'read_file', { path: '0_userdata.0/folder/umlauts.txt', length: 3 });
        assert.equal(Buffer.byteLength(chunk.content), chunk.length);
        assert.ok(!chunk.content.includes('�'), 'a multibyte character was split');

        let content = '';
        let offset = 0;
        let truncated = true;
        while (truncated) {
            const part = await callOk(ctx.mcp, 'read_file', {
                path: '0_userdata.0/folder/umlauts.txt',
                offset,
                length: 3,
            });
            content += part.content;
            offset = part.nextOffset;
            truncated = part.truncated;
        }
        assert.equal(content, 'äöü-Straße');
    });

    it('read_file can return base64', async () => {
        const data = await callOk(ctx.mcp, 'read_file', { path: '0_userdata.0/folder/test.json', base64: true });
        assert.equal(data.encoding, 'base64');
        assert.equal(Buffer.from(data.content, 'base64').toString('utf8'), '{"hello":"world"}');
    });

    it('read_file fails for a missing file and for a path without a file name', async () => {
        const missing = await call(ctx.mcp, 'read_file', { path: '0_userdata.0/folder/nope.json' });
        assert.equal(missing.isError, true);

        const noFile = await call(ctx.mcp, 'read_file', { path: '0_userdata.0' });
        assert.equal(noFile.isError, true);
        assert.match(noFile.json.error, /file name/);
    });

    it('list_files lists a directory', async () => {
        const data = await callOk(ctx.mcp, 'list_files', { path: '0_userdata.0/folder' });
        assert.deepEqual(data.files.map(file => file.file).sort(), ['test.json', 'umlauts.txt']);
        assert.equal(data.files[0].isDir, false);
        assert.ok(data.files[0].size > 0);
    });

    it('file_exists answers for both cases', async () => {
        const yes = await callOk(ctx.mcp, 'file_exists', { path: '0_userdata.0/folder/test.json' });
        assert.equal(yes.exists, true);

        const no = await callOk(ctx.mcp, 'file_exists', { path: '0_userdata.0/folder/nope.json' });
        assert.equal(no.exists, false);
    });

    it('write_file stores text and base64 content', async () => {
        await callOk(ctx.mcp, 'write_file', { path: '0_userdata.0/folder/new.txt', content: 'hello' });
        assert.equal(ctx.files['0_userdata.0']['folder/new.txt'], 'hello');

        await callOk(ctx.mcp, 'write_file', {
            path: '0_userdata.0/folder/binary.bin',
            content: Buffer.from('binary').toString('base64'),
            base64: true,
        });
        assert.equal(ctx.files['0_userdata.0']['folder/binary.bin'].toString('utf8'), 'binary');
    });

    it('delete_file removes a file', async () => {
        await callOk(ctx.mcp, 'delete_file', { path: '0_userdata.0/folder/test.json' });
        assert.equal(ctx.files['0_userdata.0']['folder/test.json'], undefined);
    });

    it('rename_file moves within the same storage and refuses to cross storages', async () => {
        await callOk(ctx.mcp, 'rename_file', {
            path: '0_userdata.0/folder/test.json',
            new_path: '0_userdata.0/backup/test.json',
        });
        assert.equal(ctx.files['0_userdata.0']['backup/test.json'], '{"hello":"world"}');
        assert.equal(ctx.files['0_userdata.0']['folder/test.json'], undefined);

        const crossed = await call(ctx.mcp, 'rename_file', {
            path: '0_userdata.0/backup/test.json',
            new_path: 'vis-2.0/backup/test.json',
        });
        assert.equal(crossed.isError, true);
        assert.match(crossed.json.error, /across adapter storages/);
    });

    it('mkdir creates a directory and rejects a bare adapter path', async () => {
        await callOk(ctx.mcp, 'mkdir', { path: '0_userdata.0/new-folder' });
        assert.ok('new-folder/' in ctx.files['0_userdata.0']);

        const bare = await call(ctx.mcp, 'mkdir', { path: '0_userdata.0' });
        assert.equal(bare.isError, true);
    });
});

describe('writing tools', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('set_state coerces the value to the state type', async () => {
        const bool = await callOk(ctx.mcp, 'set_state', { id: 'hue.0.light.state', value: 'true' });
        assert.equal(bool.value, true);
        assert.equal(ctx.states['hue.0.light.state'].val, true);
        assert.equal(ctx.states['hue.0.light.state'].ack, false);

        const num = await callOk(ctx.mcp, 'set_state', { id: 'hue.0.light.brightness', value: '80' });
        assert.equal(num.value, 80);
    });

    it('set_state honours the ack option', async () => {
        await callOk(ctx.mcp, 'set_state', { id: 'hue.0.light.state', value: true, options: { ack: true } });
        assert.equal(ctx.states['hue.0.light.state'].ack, true);
    });

    it('set_states writes a group in one call', async () => {
        const data = await callOk(ctx.mcp, 'set_states', {
            states: [
                { id: 'hue.0.light.state', value: 1 },
                { id: 'hue.0.light.brightness', value: true },
            ],
        });
        assert.equal(data.results.length, 2);
        assert.equal(data.results[0].value, true);
        assert.equal(data.results[1].value, 1);
        assert.equal(ctx.states['hue.0.light.brightness'].val, 1);
    });

    it('write_log writes to the ioBroker log', async () => {
        await callOk(ctx.mcp, 'write_log', { message: 'hello from mcp', level: 'warn' });
        assert.ok(
            ctx.logged.some(entry => entry.level === 'warn' && entry.message === 'hello from mcp'),
            'the message did not reach the adapter log',
        );
    });

    it('set_object merges into an existing object', async () => {
        await callOk(ctx.mcp, 'set_object', {
            id: 'hue.0.light.state',
            obj: { common: { name: 'Renamed' }, native: { extra: 1 } },
        });
        assert.equal(ctx.objects['hue.0.light.state'].common.name, 'Renamed');
        assert.equal(ctx.objects['hue.0.light.state'].common.role, 'switch.light', 'existing common was dropped');
        assert.equal(ctx.objects['hue.0.light.state'].native.extra, 1);
    });

    it('set_object creates a missing object', async () => {
        await callOk(ctx.mcp, 'set_object', {
            id: '0_userdata.0.fresh',
            obj: { type: 'state', common: { name: 'Fresh', type: 'string', role: 'state' }, native: {} },
        });
        assert.equal(ctx.objects['0_userdata.0.fresh'].common.name, 'Fresh');
    });

    it('delete_object removes an object and its children', async () => {
        await callOk(ctx.mcp, 'delete_object', { id: 'hue.0.light', recursive: true });
        assert.equal(ctx.objects['hue.0.light'], undefined);
        assert.equal(ctx.objects['hue.0.light.state'], undefined);
    });

    it('delete_object fails for an unknown object', async () => {
        const result = await call(ctx.mcp, 'delete_object', { id: 'nope.0.nothing' });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /does not exist/);
    });

    it('create_state creates the object and writes the default value', async () => {
        const data = await callOk(ctx.mcp, 'create_state', {
            id: '0_userdata.0.counter',
            name: 'Counter',
            type: 'number',
            role: 'value',
            unit: 'x',
            min: 0,
            max: 10,
            def: '3',
        });
        assert.equal(data.id, '0_userdata.0.counter');

        const created = ctx.objects['0_userdata.0.counter'];
        assert.equal(created.type, 'state');
        assert.equal(created.common.name, 'Counter');
        assert.equal(created.common.type, 'number');
        assert.equal(created.common.unit, 'x');
        assert.equal(created.common.max, 10);
        assert.equal(ctx.states['0_userdata.0.counter'].val, 3, 'def was not coerced to the state type');
        assert.equal(ctx.states['0_userdata.0.counter'].ack, true);
    });

    it('create_state refuses to overwrite an existing object', async () => {
        const result = await call(ctx.mcp, 'create_state', { id: 'hue.0.light.state' });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /already exists/);
    });

    it('create_scene builds a scene object for the scenes adapter', async () => {
        const data = await callOk(ctx.mcp, 'create_scene', {
            name: 'movie night',
            members: [
                { id: 'hue.0.light.state', value: true },
                { id: 'hue.0.light.brightness', value: 20 },
            ],
            description: 'dim everything',
        });
        assert.equal(data.id, 'scene.0.movie_night');
        assert.equal(data.members, 2);

        const scene = ctx.objects['scene.0.movie_night'];
        assert.equal(scene.common.role, 'scene.state');
        assert.equal(scene.common.engine, 'system.adapter.scene.0');
        assert.equal(scene.native.members.length, 2);
        assert.equal(scene.native.members[0].setIfTrue, true);
    });

    it('create_scene fails when the scene instance is missing', async () => {
        const result = await call(ctx.mcp, 'create_scene', {
            name: 'nope',
            members: [],
            instance: 'scene.9',
        });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /not installed/);
    });
});

describe('set_states permissions', () => {
    const user = 'system.user.mcp';
    let ctx;

    /**
     * Give a state an ACL: readable by everyone, writable only by the owner group.
     *
     * @param id state ID
     * @param ownerGroup the group that may write the state
     */
    function protect(id, ownerGroup) {
        ctx.objects[id].acl = { owner: 'system.user.admin', ownerGroup, object: 0x664, state: 0x664 };
    }

    beforeEach(async () => {
        ctx = await startMcp({ defaultUser: user });
        ctx.permissions[user] = {
            user,
            groups: ['system.group.mcp'],
            object: { read: true, list: true },
            state: { read: true, list: true, write: true },
        };
        protect('hue.0.light.state', 'system.group.mcp');
        protect('hue.0.light.brightness', 'system.group.administrator');
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('writes when every state is writable', async () => {
        protect('hue.0.light.brightness', 'system.group.mcp');
        const data = await callOk(ctx.mcp, 'set_states', {
            states: [
                { id: 'hue.0.light.state', value: true },
                { id: 'hue.0.light.brightness', value: 10 },
            ],
        });
        assert.deepEqual(
            data.results.map(result => result.value),
            [true, 10],
        );
        assert.equal(ctx.states['hue.0.light.brightness'].val, 10);
    });

    it('rejects the whole batch if one state is not writable', async () => {
        const result = await call(ctx.mcp, 'set_states', {
            states: [
                { id: 'hue.0.light.state', value: true },
                { id: 'hue.0.light.brightness', value: 10 },
            ],
        });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /permissionError/);
        assert.match(result.json.error, /hue\.0\.light\.brightness/);
        assert.doesNotMatch(result.json.error, /hue\.0\.light\.state\b/);
        assert.equal(ctx.states['hue.0.light.state'].val, false, 'the allowed state was written anyway');
        assert.equal(ctx.states['hue.0.light.brightness'].val, 42);
    });

    it('rejects the batch if the user has no state write permission at all', async () => {
        ctx.permissions[user].state.write = false;
        const result = await call(ctx.mcp, 'set_states', { states: [{ id: 'hue.0.light.state', value: true }] });
        assert.equal(result.isError, true);
        assert.equal(ctx.states['hue.0.light.state'].val, false);
    });

    it('rejects the batch if the user may not read a state object', async () => {
        ctx.objects['hue.0.light.brightness'].acl.object = 0x660;
        const result = await call(ctx.mcp, 'set_states', {
            states: [
                { id: 'hue.0.light.state', value: true },
                { id: 'hue.0.light.brightness', value: 10 },
            ],
        });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /hue\.0\.light\.brightness/);
        assert.equal(ctx.states['hue.0.light.state'].val, false);
    });

    it('checks the write target of an alias as well', async () => {
        ctx.objects['alias.0.lamp.level'] = {
            _id: 'alias.0.lamp.level',
            type: 'state',
            common: { name: 'Lamp level', type: 'number', role: 'level', alias: { id: 'hue.0.light.brightness' } },
            native: {},
        };
        protect('alias.0.lamp.level', 'system.group.mcp');
        const denied = await call(ctx.mcp, 'set_states', { states: [{ id: 'alias.0.lamp.level', value: 10 }] });
        assert.equal(denied.isError, true);
        assert.match(denied.json.error, /alias\.0\.lamp\.level/);

        protect('hue.0.light.brightness', 'system.group.mcp');
        await callOk(ctx.mcp, 'set_states', { states: [{ id: 'alias.0.lamp.level', value: 10 }] });
    });

    it('does not restrict states without ACL', async () => {
        delete ctx.objects['hue.0.light.brightness'].acl;
        await callOk(ctx.mcp, 'set_states', {
            states: [
                { id: 'hue.0.light.state', value: true },
                { id: 'hue.0.light.brightness', value: 10 },
            ],
        });
        assert.equal(ctx.states['hue.0.light.brightness'].val, 10);
    });

    it('skips the check for members of the administrator group', async () => {
        ctx.permissions[user].groups.push('system.group.administrator');
        await callOk(ctx.mcp, 'set_states', { states: [{ id: 'hue.0.light.brightness', value: 10 }] });
        assert.equal(ctx.states['hue.0.light.brightness'].val, 10);
    });
});

describe('ping_host', () => {
    let ctx;
    let server;
    let port;

    before(async () => {
        server = net.createServer(socket => socket.end());
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('probes an open TCP port', async () => {
        const data = await callOk(ctx.mcp, 'ping_host', { host: '127.0.0.1', port, count: 1, timeout: 1000 });
        assert.equal(data.host, '127.0.0.1');
        assert.equal(data.tcp.open, true, 'the local test server was not reachable');
        assert.equal(data.tcp.port, port);
        assert.equal(typeof data.reachable, 'boolean');
    });

    it('reports a closed TCP port', async () => {
        // Port 1 is not served by the test server, so the connect must fail (refused or timeout).
        const data = await callOk(ctx.mcp, 'ping_host', { host: '127.0.0.1', port: 1, count: 1, timeout: 1000 });
        assert.equal(data.tcp.open, false);
    });

    it('rejects a host that could be read as a ping option', async () => {
        const result = await call(ctx.mcp, 'ping_host', { host: '-rf /' });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /Invalid host/);
    });
});

describe('input validation', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    /**
     * Call a tool and assert the input schema rejected the arguments.
     *
     * @param name tool name
     * @param args deliberately invalid arguments
     * @param expected pattern the validation message must match
     */
    async function assertRejected(name, args, expected) {
        const result = await ctx.mcp.callTool(name, args);
        assert.equal(result.isError, true, `${name} accepted invalid arguments: ${result.text}`);
        assert.match(result.text, /Input validation error/);
        assert.match(result.text, expected);
    }

    it('rejects a call with a missing required argument', async () => {
        await assertRejected('get_states', {}, /ids/);
    });

    it('rejects a call with a wrongly typed argument', async () => {
        await assertRejected('get_states', { ids: 'hue.0.light.state' }, /ids/);
    });

    it('rejects a value outside the declared range', async () => {
        await assertRejected('ping_host', { host: '127.0.0.1', port: 70000 }, /port/);
    });

    it('rejects a value outside the declared enum', async () => {
        await assertRejected('write_log', { message: 'x', level: 'fatal' }, /level/);
    });

    it('rejects an unknown tool', async () => {
        const result = await ctx.mcp.callTool('no_such_tool', {});
        assert.equal(result.isError, true);
        assert.match(result.text, /not found/);
    });
});
