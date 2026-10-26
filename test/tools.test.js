/**
 * Functional tests: every declared tool is called through a real MCP client/server pair
 * (in-memory transport) on top of the mock adapter, and its result is verified.
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const { startMcp, call, callOk } = require('./helpers');

/** Format a time like js-controller does in the log file (local time). */
function logTime(ts) {
    const date = new Date(ts);
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    );
}

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
        assert.equal(data.states[0].exists, false);
        assert.equal(data.states[0].ts, undefined, 'no made-up timestamp for a missing state');
    });

    it('get_states tells an object without a value from a missing one', async () => {
        delete ctx.states['hue.0.light.state'];
        const data = await callOk(ctx.mcp, 'get_states', { ids: ['hue.0.light.state', 'hue.0.light'] });
        assert.equal(data.states[0].exists, true);
        assert.match(data.states[0].hint, /no value yet/);
        assert.equal(data.states[1].exists, true);
        assert.match(data.states[1].hint, /channel object, not a state/);
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

    it('get_logs reports the newest line and the size of the log file', async () => {
        const data = await callOk(ctx.mcp, 'get_logs', { level: ['error'] });
        assert.equal(data.logFile.size, 4096);
        // the newest line of the whole file, not of the filtered result
        assert.equal(data.logFile.newestLineTs, new Date('2026-06-12T11:46:42.000').getTime());
        assert.match(data.logFile.hint, /minutes old/);

        ctx.hostLogs.splice(-1, 0, `${logTime(Date.now())}  - info: hue.0 (1235) Fresh`);
        const fresh = await callOk(ctx.mcp, 'get_logs', {});
        assert.equal(fresh.logFile.hint, undefined);
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

    it('check_permissions reports the rights of the user on objects', async () => {
        const data = await callOk(ctx.mcp, 'check_permissions', {
            ids: ['hue.0.light.state', 'hue.0.light.brightness', 'hue.0.light', 'nope.0.missing'],
        });
        assert.equal(data.user, user);
        assert.deepEqual(data.groups, ['system.group.mcp']);
        assert.equal(data.admin, false);
        assert.equal(data.rights.state.write, true);
        const [own, foreign, channel, missing] = data.objects;
        assert.deepEqual(own.object, { read: true, write: false, delete: false });
        assert.deepEqual(own.state, { read: true, write: true });
        assert.equal(own.acl.ownerGroup, 'system.group.mcp');
        assert.deepEqual(foreign.state, { read: true, write: false });
        assert.equal(channel.state, undefined);
        assert.equal(channel.object.read, true);
        assert.deepEqual(missing, { id: 'nope.0.missing', exists: false });
    });

    it('check_permissions hides the ACL of objects the user may not read', async () => {
        ctx.objects['hue.0.light.brightness'].acl.object = 0x660;
        const data = await callOk(ctx.mcp, 'check_permissions', { ids: ['hue.0.light.brightness'] });
        assert.equal(data.objects[0].object.read, false);
        assert.equal(data.objects[0].acl, undefined);
    });

    it('check_permissions grants everything to administrators', async () => {
        ctx.permissions[user].groups.push('system.group.administrator');
        const data = await callOk(ctx.mcp, 'check_permissions', { ids: ['hue.0.light.brightness'] });
        assert.equal(data.admin, true);
        assert.deepEqual(data.objects[0].object, { read: true, write: true, delete: true });
        assert.deepEqual(data.objects[0].state, { read: true, write: true });
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

describe('install_package', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('installs from npm on the own host and restarts enabled instances', async () => {
        ctx.objects['system.adapter.hue.0'] = {
            _id: 'system.adapter.hue.0',
            type: 'instance',
            common: { name: 'hue', enabled: true },
            native: {},
        };
        const data = await callOk(ctx.mcp, 'install_package', { source: 'hue', start_timeout: 1 });
        assert.equal(ctx.cmdExec.sent.length, 1);
        assert.equal(ctx.cmdExec.sent[0].host, 'system.host.testhost');
        assert.equal(ctx.cmdExec.sent[0].data, 'url iobroker.hue --host testhost');
        assert.equal(data.success, true);
        assert.equal(data.exitCode, 0);
        assert.equal(data.adapter, 'hue');
        assert.deepEqual(data.restartedInstances, ['hue.0']);
        assert.deepEqual(ctx.extended, ['system.adapter.hue.0']);
        assert.deepEqual(data.output, ['install url iobroker.hue --host testhost']);
        assert.equal(data.instances[0].id, 'hue.0');
        assert.equal(data.instances[0].alive, false);
    });

    it('reports whether the restarted instances came up and their first log lines', async () => {
        ctx.objects['system.adapter.hue.0'] = {
            _id: 'system.adapter.hue.0',
            type: 'instance',
            common: { name: 'hue', enabled: true, mode: 'daemon' },
            native: {},
        };
        ctx.objects['system.adapter.hue.1'] = {
            _id: 'system.adapter.hue.1',
            type: 'instance',
            common: { name: 'hue', enabled: true, mode: 'schedule' },
            native: {},
        };
        // the heartbeat of the old process refreshes ts, but not lc
        ctx.states['system.adapter.hue.0.alive'] = { val: true, ack: true, ts: Date.now() + 10_000, lc: 1 };
        const extend = ctx.adapter.extendForeignObjectAsync;
        ctx.adapter.extendForeignObjectAsync = async (id, obj) => {
            const result = await extend(id, obj);
            setTimeout(() => {
                const now = Date.now();
                ctx.states[`${id}.alive`] = { val: true, ack: true, ts: now, lc: now };
                ctx.hostLogs.splice(-1, 0, `${logTime(now)}  - info: hue.0 (1240) starting. Version 3.9.1`);
            }, 700);
            return result;
        };
        const data = await callOk(ctx.mcp, 'install_package', { source: 'hue', start_timeout: 5 });
        assert.deepEqual(data.restartedInstances, ['hue.0', 'hue.1']);
        assert.equal(data.instances[0].alive, true);
        assert.match(data.instances[0].logs[0].message, /starting\. Version 3\.9\.1/);
        assert.equal(data.instances[1].mode, 'schedule');
        assert.equal(data.instances[1].alive, undefined);
    });

    it('sends a .tgz from the file storage along with the command', async () => {
        ctx.files['0_userdata.0']['dev/iobroker.hue-3.9.1.tgz'] = Buffer.from('tgz-data');
        const data = await callOk(ctx.mcp, 'install_package', {
            file_path: '0_userdata.0/dev/iobroker.hue-3.9.1.tgz',
            debug: true,
        });
        const sent = ctx.cmdExec.sent[0];
        assert.equal(sent.data, 'url iobroker.hue-3.9.1.tgz --host testhost --debug');
        assert.deepEqual(sent.files, [
            { name: 'iobroker.hue-3.9.1.tgz', file: Buffer.from('tgz-data').toString('base64') },
        ]);
        assert.equal(data.adapter, 'hue');
    });

    it('accepts an inline base64 .tgz', async () => {
        await callOk(ctx.mcp, 'install_package', {
            file_name: 'my adapter.tgz',
            file_content: Buffer.from('x').toString('base64'),
        });
        assert.equal(ctx.cmdExec.sent[0].data, 'url my_adapter.tgz --host testhost');
        assert.equal(ctx.cmdExec.sent[0].files[0].name, 'my_adapter.tgz');
    });

    it('reports a failed installation and restarts nothing', async () => {
        ctx.cmdExec.exitCode = 1;
        const data = await callOk(ctx.mcp, 'install_package', { source: 'ioBroker/ioBroker.hue#main' });
        assert.equal(data.success, false);
        assert.equal(data.exitCode, 1);
        assert.deepEqual(ctx.extended, []);
    });

    it('returns after the timeout when the host does not answer', async () => {
        ctx.cmdExec.reply = false;
        const data = await callOk(ctx.mcp, 'install_package', { source: 'hue', timeout: 1 });
        assert.equal(data.finished, false);
        assert.match(data.note, /keeps running/);
    });

    it('rejects ambiguous, unsafe or unknown input', async () => {
        for (const args of [
            {},
            { source: 'hue', file_path: '0_userdata.0/x.tgz' },
            { source: 'hue --force' },
            { source: '--debug' },
            { source: 'hue', host: 'unknown' },
            { file_name: 'x.zip', file_content: 'eA==' },
            { file_content: 'eA==' },
        ]) {
            const result = await call(ctx.mcp, 'install_package', args);
            assert.equal(result.isError, true, `accepted ${JSON.stringify(args)}`);
        }
        assert.equal(ctx.cmdExec.sent.length, 0);
    });
});

describe('instance control', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
        ctx.objects['system.adapter.hue.0'] = {
            _id: 'system.adapter.hue.0',
            type: 'instance',
            common: { name: 'hue', enabled: true, host: 'testhost', loglevel: 'info' },
            native: { bridge: '1.2.3.4' },
        };
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('stop_instance and start_instance toggle common.enabled', async () => {
        let data = await callOk(ctx.mcp, 'stop_instance', { id: 'hue.0' });
        assert.deepEqual(data, { id: 'hue.0', enabled: false, changed: true });
        assert.equal(ctx.objects['system.adapter.hue.0'].common.enabled, false);
        assert.equal(ctx.objects['system.adapter.hue.0'].native.bridge, '1.2.3.4', 'native was lost');

        data = await callOk(ctx.mcp, 'start_instance', { id: 'system.adapter.hue.0' });
        assert.equal(data.changed, true);
        assert.equal(ctx.objects['system.adapter.hue.0'].common.enabled, true);

        data = await callOk(ctx.mcp, 'start_instance', { id: 'hue.0' });
        assert.equal(data.changed, false);
    });

    it('restart_instance touches the instance object, but only of a running instance', async () => {
        await callOk(ctx.mcp, 'restart_instance', { id: 'hue.0' });
        assert.deepEqual(ctx.extended, ['system.adapter.hue.0']);

        ctx.objects['system.adapter.hue.0'].common.enabled = false;
        const result = await call(ctx.mcp, 'restart_instance', { id: 'hue.0' });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /not enabled/);
    });

    it('set_log_level writes the logLevel state or the instance object', async () => {
        await callOk(ctx.mcp, 'set_log_level', { id: 'hue.0', level: 'debug' });
        assert.equal(ctx.states['system.adapter.hue.0.logLevel'].val, 'debug');
        assert.equal(ctx.states['system.adapter.hue.0.logLevel'].ack, false);
        assert.equal(ctx.objects['system.adapter.hue.0'].common.loglevel, 'info');

        await callOk(ctx.mcp, 'set_log_level', { id: 'hue.0', level: 'warn', persistent: true });
        assert.equal(ctx.objects['system.adapter.hue.0'].common.loglevel, 'warn');
    });

    it('refuses unknown or invalid instances', async () => {
        for (const id of ['nope.0', 'hue', 'hue.0; rm -rf']) {
            const result = await call(ctx.mcp, 'start_instance', { id });
            assert.equal(result.isError, true, `accepted ${id}`);
        }
    });
});

describe('adapter management', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
        ctx.objects['system.adapter.hue'] = {
            _id: 'system.adapter.hue',
            type: 'adapter',
            common: { name: 'hue', version: '3.8.0', titleLang: { en: 'Philips Hue' } },
            native: {},
        };
        ctx.objects['system.adapter.hue.0'] = {
            _id: 'system.adapter.hue.0',
            type: 'instance',
            common: { name: 'hue', enabled: true, host: 'testhost' },
            native: {},
        };
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('list_adapter_updates compares the installed with the repository version', async () => {
        const data = await callOk(ctx.mcp, 'list_adapter_updates', {});
        assert.deepEqual(data.updates, [{ name: 'hue', installed: '3.8.0', available: '3.9.0', title: 'Philips Hue' }]);
    });

    it('add_instance runs "iobroker add" on the host', async () => {
        const data = await callOk(ctx.mcp, 'add_instance', { adapter: 'zigbee', instance: 1 });
        assert.equal(ctx.cmdExec.sent[0].data, 'add zigbee 1 --host testhost');
        assert.equal(data.success, true);

        const result = await call(ctx.mcp, 'add_instance', { adapter: 'hue', instance: 0 });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /already exists/);
    });

    it('delete_instance runs "iobroker del" on the host of the instance', async () => {
        await callOk(ctx.mcp, 'delete_instance', { id: 'hue.0' });
        assert.equal(ctx.cmdExec.sent[0].host, 'system.host.testhost');
        assert.equal(ctx.cmdExec.sent[0].data, 'del hue.0');
    });

    it('upgrade_adapter upgrades to the repository or the given version', async () => {
        await callOk(ctx.mcp, 'upgrade_adapter', { adapter: 'iobroker.hue' });
        assert.equal(ctx.cmdExec.sent[0].data, 'upgrade hue@3.9.0');
        await callOk(ctx.mcp, 'upgrade_adapter', { adapter: 'hue', version: '3.9.1-beta.0' });
        assert.equal(ctx.cmdExec.sent[1].data, 'upgrade hue@3.9.1-beta.0');
    });

    it('refuses invalid adapters and versions', async () => {
        for (const [name, args] of [
            ['add_instance', { adapter: 'hue --force' }],
            ['upgrade_adapter', { adapter: 'zigbee' }],
            ['upgrade_adapter', { adapter: 'hue', version: '1.0.0 --force' }],
            ['delete_instance', { id: 'nope.0' }],
        ]) {
            const result = await call(ctx.mcp, name, args);
            assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(args)}`);
        }
        assert.equal(ctx.cmdExec.sent.length, 0);
    });
});

describe('notifications', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('list_notifications flattens the notifications of the running hosts', async () => {
        const data = await callOk(ctx.mcp, 'list_notifications', { language: 'de' });
        assert.deepEqual(data.notifications, [
            {
                host: 'testhost',
                scope: 'system',
                category: 'diskSpaceIssues',
                instance: 'system.host.testhost',
                severity: 'alert',
                name: 'Speicherplatz knapp',
                description: 'Free some space',
                messages: [{ message: 'Only 2 % left', ts: 1_750_000_000_000 }],
            },
        ]);
    });

    it('clear_notifications forwards the filter to the host', async () => {
        await callOk(ctx.mcp, 'clear_notifications', { scope: 'system', instance: 'hue.0' });
        assert.deepEqual(ctx.messages.notificationsCleared, [
            {
                host: 'system.host.testhost',
                scope: 'system',
                category: null,
                instance: 'system.adapter.hue.0',
            },
        ]);
    });
});

describe('scripts', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
        ctx.objects['system.adapter.javascript.0'] = {
            _id: 'system.adapter.javascript.0',
            type: 'instance',
            common: { name: 'javascript', enabled: true },
            native: {},
        };
        ctx.objects['script.js.common'] = { _id: 'script.js.common', type: 'channel', common: { name: 'common' } };
        ctx.objects['script.js.common.lights'] = {
            _id: 'script.js.common.lights',
            type: 'script',
            common: {
                name: 'Lights',
                engineType: 'Javascript/js',
                enabled: true,
                engine: 'system.adapter.javascript.0',
                source: 'log("on");',
            },
            native: {},
        };
        ctx.objects['script.js.common.blocks'] = {
            _id: 'script.js.common.blocks',
            type: 'script',
            common: { name: 'Blocks', engineType: 'Blockly', enabled: false, source: '//xml' },
            native: {},
        };
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('list_scripts lists the scripts without source', async () => {
        const data = await callOk(ctx.mcp, 'list_scripts', {});
        assert.deepEqual(
            data.scripts.map(script => script.id),
            ['script.js.common.lights', 'script.js.common.blocks'],
        );
        assert.equal(data.scripts[0].engine, 'javascript.0');
        assert.equal(data.scripts[0].source, undefined);
    });

    it('get_script returns the source and accepts short ids', async () => {
        const data = await callOk(ctx.mcp, 'get_script', { id: 'lights' });
        assert.equal(data.id, 'script.js.common.lights');
        assert.equal(data.source, 'log("on");');
    });

    it('set_script creates a disabled script with its folders', async () => {
        const data = await callOk(ctx.mcp, 'set_script', { id: 'garden.water pump', source: 'log(1);' });
        assert.deepEqual(data, { id: 'script.js.garden.water_pump', created: true });
        assert.equal(ctx.objects['script.js.garden'].type, 'channel');
        const common = ctx.objects['script.js.garden.water_pump'].common;
        assert.equal(common.enabled, false);
        assert.equal(common.engine, 'system.adapter.javascript.0');
        assert.equal(common.engineType, 'Javascript/js');
        assert.equal(common.source, 'log(1);');
    });

    it('set_script changes the source of a JavaScript, but not of a Blockly script', async () => {
        await callOk(ctx.mcp, 'set_script', { id: 'common.lights', source: 'log("off");' });
        assert.equal(ctx.objects['script.js.common.lights'].common.source, 'log("off");');
        assert.equal(ctx.objects['script.js.common.lights'].common.enabled, true);

        const result = await call(ctx.mcp, 'set_script', { id: 'common.blocks', source: 'x' });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /Blockly/);
    });

    it('enable_script and delete_script', async () => {
        await callOk(ctx.mcp, 'enable_script', { id: 'common.lights', enabled: false });
        assert.equal(ctx.objects['script.js.common.lights'].common.enabled, false);
        await callOk(ctx.mcp, 'delete_script', { id: 'script.js.common.lights' });
        assert.equal(ctx.objects['script.js.common.lights'], undefined);
    });

    it('run_script sends the code to the javascript adapter', async () => {
        const data = await callOk(ctx.mcp, 'run_script', { source: 'log(1)', timeout: 100 });
        assert.equal(data.output, 'ran log(1)');
        const sent = ctx.messages.sent[0];
        assert.equal(sent.instance, 'javascript.0');
        assert.equal(sent.command, 'execute');
        assert.equal(sent.message.timeout, 100);
        assert.equal(sent.options.user, 'system.user.admin');
    });
});

describe('send_to', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
        for (const id of ['telegram.0', 'backitup.0', 'backitup.1', 'hue.0']) {
            ctx.objects[`system.adapter.${id}`] = {
                _id: `system.adapter.${id}`,
                type: 'instance',
                common: { name: id.split('.')[0], enabled: true },
                native: {},
            };
        }
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('sends to allowed adapters and instances and returns the answer', async () => {
        const data = await callOk(ctx.mcp, 'send_to', {
            instance: 'telegram.0',
            command: 'send',
            message: { text: 'Hi' },
        });
        assert.deepEqual(data, { instance: 'telegram.0', command: 'send', response: { echo: { text: 'Hi' } } });
        await callOk(ctx.mcp, 'send_to', { instance: 'backitup.0', command: 'oneClick' });
    });

    it('refuses instances outside the allowlist', async () => {
        for (const instance of ['backitup.1', 'hue.0']) {
            const result = await call(ctx.mcp, 'send_to', { instance, command: 'x' });
            assert.equal(result.isError, true, `sent to ${instance}`);
            assert.match(result.json.error, /allowlist/);
        }
        assert.equal(ctx.messages.sent.length, 0);
    });
});

describe('create_alias', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    it('creates an alias with the metadata of the target', async () => {
        const data = await callOk(ctx.mcp, 'create_alias', {
            id: 'livingroom.brightness',
            target: 'hue.0.light.brightness',
        });
        assert.equal(data.id, 'alias.0.livingroom.brightness');
        const common = ctx.objects['alias.0.livingroom.brightness'].common;
        assert.equal(common.alias.id, 'hue.0.light.brightness');
        assert.equal(common.type, 'number');
        assert.equal(common.role, 'level.dimmer');
        assert.equal(common.unit, ctx.objects['hue.0.light.brightness'].common.unit);
    });

    it('supports separate read and write states and refuses duplicates', async () => {
        await callOk(ctx.mcp, 'create_alias', {
            id: 'alias.0.lamp',
            target: 'hue.0.light.state',
            write_target: 'hue.0.light.brightness',
            name: 'Lamp',
        });
        assert.deepEqual(ctx.objects['alias.0.lamp'].common.alias.id, {
            read: 'hue.0.light.state',
            write: 'hue.0.light.brightness',
        });
        const result = await call(ctx.mcp, 'create_alias', { id: 'lamp', target: 'hue.0.light.state' });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /already exists/);
    });
});

describe('prompts and confirmations', () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    const { McpServer } = require('../build/index.js');
    const { createMockAdapter } = require('./mockAdapter');

    /** Connect an SDK client that supports elicitation and answers it with `answer`. */
    async function connect(answer, options = {}) {
        const mock = createMockAdapter();
        const mcp = McpServer.createEmbedded({ adapter: mock.adapter, allowObjectChange: true, ...options });
        const server = mcp.createInProcessServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: {} } });
        const asked = [];
        client.setRequestHandler(ElicitRequestSchema, request => {
            asked.push(request.params.message);
            return answer;
        });
        await client.connect(clientTransport);
        const close = async () => {
            await client.close();
            await server.close();
            mcp.unload();
        };
        return { mock, client, asked, close };
    }

    it('asks before deleting and stops when the user declines', async () => {
        const ctx = await connect({ action: 'decline' });
        try {
            const result = await ctx.client.callTool({ name: 'delete_object', arguments: { id: 'hue.0.light' } });
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, /Cancelled by the user/);
            assert.ok(ctx.mock.objects['hue.0.light'], 'deleted although declined');
            assert.match(ctx.asked[0], /hue\.0\.light/);
        } finally {
            await ctx.close();
        }
    });

    it('explains a dismissed confirmation instead of blaming the user', async () => {
        const ctx = await connect({ action: 'cancel' });
        try {
            const result = await ctx.client.callTool({ name: 'delete_object', arguments: { id: 'hue.0.light' } });
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, /dismissed without an answer/);
            assert.match(result.content[0].text, /Ask for confirmation before dangerous actions/);
            assert.ok(ctx.mock.objects['hue.0.light']);
        } finally {
            await ctx.close();
        }
    });

    it('deletes after the user confirmed', async () => {
        const ctx = await connect({ action: 'accept', content: { confirm: true } });
        try {
            const result = await ctx.client.callTool({ name: 'delete_object', arguments: { id: 'hue.0.light' } });
            assert.equal(result.isError, undefined);
            assert.equal(ctx.mock.objects['hue.0.light'], undefined);
        } finally {
            await ctx.close();
        }
    });

    it('does not ask when confirmDangerous is off', async () => {
        const ctx = await connect({ action: 'decline' }, { confirmDangerous: false });
        try {
            await ctx.client.callTool({ name: 'delete_object', arguments: { id: 'hue.0.light' } });
            assert.equal(ctx.asked.length, 0);
            assert.equal(ctx.mock.objects['hue.0.light'], undefined);
        } finally {
            await ctx.close();
        }
    });

    it('offers the prompts', async () => {
        const ctx = await connect({ action: 'decline' });
        try {
            const { prompts } = await ctx.client.listPrompts();
            assert.deepEqual(prompts.map(prompt => prompt.name).sort(), [
                'create_automation',
                'diagnose_adapter',
                'room_overview',
            ]);
            const prompt = await ctx.client.getPrompt({ name: 'diagnose_adapter', arguments: { instance: 'hue.0' } });
            assert.match(prompt.messages[0].content.text, /"hue\.0"/);
        } finally {
            await ctx.close();
        }
    });
});

describe('large results', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await startMcp();
    });

    afterEach(async () => {
        await ctx.mcp.close();
    });

    /** Add `count` states with a long name, about 1 KB per search result. */
    function addBigObjects(count) {
        for (let i = 0; i < count; i++) {
            const id = `big.0.state${String(i).padStart(4, '0')}`;
            ctx.objects[id] = {
                _id: id,
                type: 'state',
                common: { name: `Big state ${i} ${'x'.repeat(1000)}`, type: 'number', role: 'value', read: true },
                native: {},
            };
        }
    }

    it('search_objects tells when the limit cut the results', async () => {
        const data = await callOk(ctx.mcp, 'search_objects', { query: '', limit: 2 });
        assert.equal(data.results.length, 2);
        assert.equal(data.truncated, true);
        assert.equal(data.nextOffset, 2);
        assert.ok(data.total > 2);
        assert.equal(data.download_url, undefined);

        const next = await callOk(ctx.mcp, 'search_objects', { query: '', limit: 2, offset: 2 });
        assert.notEqual(next.results[0].id, data.results[0].id);
    });

    it('search_objects pages a result that is too large for one answer', async () => {
        addBigObjects(1500);
        const first = await callOk(ctx.mcp, 'search_objects', { query: 'big.0.', limit: 9999 });
        assert.equal(first.truncated, true);
        assert.equal(first.total, 1500);
        assert.ok(first.results.length > 100 && first.results.length < 1500, `${first.results.length} results`);
        assert.equal(first.nextOffset, first.results.length);
        // In-process there is no HTTP server for links
        assert.equal(first.download_url, undefined);
        assert.match(first.hint, /offset=nextOffset/);

        const ids = first.results.map(result => result.id);
        let offset = first.nextOffset;
        while (offset !== undefined) {
            const page = await callOk(ctx.mcp, 'search_objects', { query: 'big.0.', limit: 9999, offset });
            ids.push(...page.results.map(result => result.id));
            offset = page.nextOffset;
        }
        assert.equal(new Set(ids).size, 1500);
    });

    it('never returns a result above the size limit of the clients', async () => {
        ctx.objects['big.0.huge'] = {
            _id: 'big.0.huge',
            type: 'state',
            common: {},
            native: { blob: 'x'.repeat(2_000_000) },
        };
        const result = await call(ctx.mcp, 'get_object', { id: 'big.0.huge' });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /larger than 900 KB/);
    });

    it('read_file with download needs links', async () => {
        const result = await call(ctx.mcp, 'read_file', { path: '0_userdata.0/folder/test.json', download: true });
        assert.equal(result.isError, true);
        assert.match(result.json.error, /not available in this mode/);
    });

    it('write_file needs either content or upload_id', async () => {
        const none = await call(ctx.mcp, 'write_file', { path: '0_userdata.0/folder/x.txt' });
        assert.equal(none.isError, true);
        assert.match(none.json.error, /either "content" or "upload_id"/);
        const unknown = await call(ctx.mcp, 'write_file', { path: '0_userdata.0/folder/x.txt', upload_id: 'abc' });
        assert.equal(unknown.isError, true);
        assert.match(unknown.json.error, /Unknown or expired upload/);
    });

    it('offers no prepare_upload in-process', async () => {
        const tools = await ctx.mcp.listTools();
        assert.ok(tools.length > 0);
        assert.ok(!tools.some(tool => tool.name === 'prepare_upload'));
    });
});

describe('failed logins', () => {
    const { EventEmitter } = require('node:events');
    const { McpServer } = require('../build/index.js');
    const { createMockAdapter } = require('./mockAdapter');

    /** Run a request through the logging middleware and answer it with `status`. */
    function login(mock, req, status) {
        const mcp = McpServer.createEmbedded({ adapter: mock.adapter });
        const res = new EventEmitter();
        res.statusCode = status;
        let passed = false;
        mcp.logFailedLogin({ method: 'POST', ip: '192.168.1.7', ...req }, res, () => (passed = true));
        res.emit('finish');
        mcp.unload();
        assert.ok(passed, 'the request must be passed on');
        return mock.logged.filter(entry => entry.message.includes('Rejected'));
    }

    it('names the address and the client of a wrong Basic auth password', () => {
        const mock = createMockAdapter();
        const logged = login(
            mock,
            {
                path: '/mcp',
                headers: {
                    authorization: `Basic ${Buffer.from('mcp:wrong').toString('base64')}`,
                    'user-agent': 'Claude-User',
                },
            },
            401,
        );
        assert.equal(logged.length, 1);
        assert.equal(logged[0].level, 'warn');
        assert.match(logged[0].message, /"mcp" from 192\.168\.1\.7 \(User-Agent: "Claude-User"\)/);
        assert.doesNotMatch(logged[0].message, /wrong/, 'the password must not be logged');
    });

    it('names the client of a failed password grant', () => {
        const mock = createMockAdapter();
        const logged = login(
            mock,
            { path: '/oauth/token', headers: {}, body: { grant_type: 'password', username: 'mcp', password: 'x' } },
            400,
        );
        assert.equal(logged[0].level, 'warn');
        assert.match(logged[0].message, /"mcp" from 192\.168\.1\.7/);
    });

    it('logs a rejected token only in debug', () => {
        const mock = createMockAdapter();
        const logged = login(mock, { path: '/mcp', headers: { authorization: 'Bearer expired' } }, 401);
        assert.equal(logged[0].level, 'debug');
    });

    it('does not log successful requests', () => {
        const mock = createMockAdapter();
        const logged = login(mock, { path: '/mcp', headers: { authorization: 'Bearer valid' } }, 200);
        assert.equal(logged.length, 0);
    });
});
