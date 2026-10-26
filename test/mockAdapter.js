/**
 * An in-memory stand-in for an `ioBroker.Adapter`, good enough to drive the MCP server.
 *
 * Only the subset of the adapter API the MCP tools actually use is implemented (objects, states,
 * the file storage, history, `sendToHost` and the log/subscription plumbing). Every method keeps
 * its real signature so the tools can be exercised exactly as an MCP client would call them.
 */

/** Turn an ioBroker id pattern ("hue.0.*") into a regular expression. */
function patternToRegExp(pattern) {
    const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

/** The objects every test starts with. */
function defaultObjects() {
    const objects = {
        'system.config': {
            _id: 'system.config',
            type: 'config',
            common: { language: 'en', activeRepo: 'stable' },
            native: {},
        },
        'system.repositories': {
            _id: 'system.repositories',
            type: 'config',
            common: {},
            native: {
                repositories: {
                    stable: {
                        json: {
                            _repoInfo: { stable: true },
                            hue: {
                                version: '3.9.0',
                                titleLang: { en: 'Philips Hue' },
                                desc: { en: 'Control Philips Hue bridges' },
                                keywords: ['hue', 'light'],
                                type: 'lighting',
                            },
                            zigbee: {
                                version: '1.10.0',
                                titleLang: { en: 'Zigbee' },
                                desc: { en: 'Zigbee devices via coordinator' },
                                keywords: ['zigbee'],
                                type: 'hardware',
                            },
                        },
                    },
                },
            },
        },
        'system.host.testhost': {
            _id: 'system.host.testhost',
            type: 'host',
            common: { name: 'testhost', installedVersion: '7.0.6' },
            native: { os: { platform: 'linux' } },
        },
        'system.adapter.admin': {
            _id: 'system.adapter.admin',
            type: 'adapter',
            common: {
                name: 'admin',
                version: '7.4.10',
                titleLang: { en: 'Admin' },
                desc: { en: 'The ioBroker administration UI' },
                keywords: ['ui'],
                mode: 'daemon',
            },
            native: {},
        },
        'system.adapter.admin.0': {
            _id: 'system.adapter.admin.0',
            type: 'instance',
            common: { name: 'admin', enabled: true, version: '7.4.10', titleLang: { en: 'Admin' } },
            native: {},
        },
        'system.adapter.scene.0': {
            _id: 'system.adapter.scene.0',
            type: 'instance',
            common: { name: 'scene', enabled: true, version: '2.0.0', titleLang: { en: 'Scenes' } },
            native: {},
        },
        'enum.rooms.living_room': {
            _id: 'enum.rooms.living_room',
            type: 'enum',
            common: {
                name: { en: 'Living room', de: 'Wohnzimmer' },
                color: '#ff0000',
                icon: 'room.png',
                members: ['hue.0.light'],
            },
            native: {},
        },
        'enum.functions.light': {
            _id: 'enum.functions.light',
            type: 'enum',
            common: { name: { en: 'Light', de: 'Licht' }, members: ['hue.0.light'] },
            native: {},
        },
        'hue.0.light': {
            _id: 'hue.0.light',
            type: 'channel',
            common: { name: { en: 'Ceiling lamp', de: 'Deckenlampe' }, role: 'light' },
            native: {},
        },
        'hue.0.light.state': {
            _id: 'hue.0.light.state',
            type: 'state',
            common: { name: 'Switch', type: 'boolean', role: 'switch.light', read: true, write: true },
            native: {},
        },
        'hue.0.light.brightness': {
            _id: 'hue.0.light.brightness',
            type: 'state',
            common: {
                name: 'Brightness',
                type: 'number',
                role: 'level.dimmer',
                read: true,
                write: true,
                unit: '%',
                min: 0,
                max: 100,
            },
            native: {},
        },
    };
    return objects;
}

/** The states every test starts with. */
function defaultStates() {
    const ts = 1_750_000_000_000;
    return {
        'system.adapter.admin.0.alive': { val: true, ack: true, ts },
        'system.adapter.admin.0.connected': { val: true, ack: true, ts },
        'system.adapter.scene.0.alive': { val: true, ack: true, ts },
        'system.host.testhost.alive': { val: true, ack: true, ts },
        'hue.0.light.state': { val: false, ack: true, ts },
        'hue.0.light.brightness': { val: 42, ack: true, ts },
    };
}

/** The file storage every test starts with: `<adapter>` -> `<file name>` -> content. */
function defaultFiles() {
    return {
        '0_userdata.0': {
            'folder/test.json': '{"hello":"world"}',
            'folder/umlauts.txt': 'äöü-Straße',
        },
    };
}

/**
 * Create the mock adapter.
 *
 * @returns the adapter plus the in-memory stores, so tests can inspect what a tool changed
 */
function createMockAdapter() {
    const objects = defaultObjects();
    const states = defaultStates();
    const files = defaultFiles();
    /** Every log line the tools wrote, as `{ level, message }`. */
    const logged = [];
    /**
     * Raw log lines the host returns for `sendToHost('getLogs')`. Like js-controller: the file ends with a
     * newline (empty last line), followed by the file size as a string.
     */
    const hostLogs = [
        '2026-06-12 11:46:39.802  - error: hm-rpc.0 (1234) Init not possible',
        '2026-06-12 11:46:40.100  - warn: hue.0 (1235) Bridge answered slowly',
        '2026-06-12 11:46:41.500  - info: admin.0 (1236) Server listening on port 8081',
        '2026-06-12 11:46:42.000  - debug: hue.0 (1235) Polling',
        '',
        '4096',
    ];
    /**
     * `cmdExec` messages sent to a host (`install_package`), and how the simulated host answers:
     * with `exitCode`, or not at all when `reply` is false.
     */
    const cmdExec = { sent: [], exitCode: 0, reply: true };
    /** Ids of the objects touched via `extendForeignObjectAsync` (instance restarts). */
    const extended = [];
    /** Messages sent with `sendToAsync`, and the notifications the host reports and clears. */
    const messages = { sent: [], notificationsCleared: [] };
    const notifications = {
        system: {
            name: { en: 'System', de: 'System' },
            categories: {
                diskSpaceIssues: {
                    name: { en: 'Disk space low', de: 'Speicherplatz knapp' },
                    description: { en: 'Free some space' },
                    severity: 'alert',
                    instances: {
                        'system.host.testhost': { messages: [{ message: 'Only 2 % left', ts: 1_750_000_000_000 }] },
                    },
                },
                emptyCategory: {
                    name: { en: 'Nothing' },
                    severity: 'info',
                    instances: { 'system.adapter.hue.0': { messages: [] } },
                },
            },
        },
    };
    const listeners = {};
    const subscriptions = { states: [], objects: [], log: [] };
    /** Merged group permissions per user, as returned by `calculatePermissionsAsync`. */
    const permissions = {};

    /** Object read check of js-controller for a non-admin user (only the ACL bits, no group rights). */
    const canReadObject = (obj, user) => {
        if (!obj || !obj.acl || user === 'system.user.admin') {
            return true;
        }
        const groups = (permissions[user] && permissions[user].groups) || [];
        if (obj.acl.owner === user) {
            return !!(obj.acl.object & 0x400);
        }
        if (groups.includes(obj.acl.ownerGroup)) {
            return !!(obj.acl.object & 0x040);
        }
        return !!(obj.acl.object & 0x004);
    };

    const log = {
        error: message => logged.push({ level: 'error', message }),
        warn: message => logged.push({ level: 'warn', message }),
        info: message => logged.push({ level: 'info', message }),
        debug: message => logged.push({ level: 'debug', message }),
        silly: message => logged.push({ level: 'silly', message }),
    };

    const rowsOfType = (type, params) => {
        const startkey = params && params.startkey;
        const endkey = params && params.endkey;
        return Object.values(objects)
            .filter(obj => obj.type === type)
            .filter(
                obj => (startkey === undefined || obj._id >= startkey) && (endkey === undefined || obj._id <= endkey),
            )
            .sort((a, b) => (a._id < b._id ? -1 : 1))
            .map(obj => ({ id: obj._id, value: obj }));
    };

    const adapter = {
        name: 'mcp',
        namespace: 'mcp.0',
        host: 'testhost',
        config: {},
        log,

        // --- event plumbing -------------------------------------------------
        on(event, handler) {
            (listeners[event] = listeners[event] || []).push(handler);
        },
        removeListener(event, handler) {
            listeners[event] = (listeners[event] || []).filter(one => one !== handler);
        },
        /** Emit an event to the handlers the MCP server registered (used to simulate log/state changes). */
        emit(event, payload) {
            for (const handler of listeners[event] || []) {
                handler(payload);
            }
        },

        // --- objects --------------------------------------------------------
        getForeignObjectAsync(id, options) {
            if (options && options.user && !canReadObject(objects[id], options.user)) {
                return Promise.reject(new Error('permissionError'));
            }
            return Promise.resolve(objects[id] ? JSON.parse(JSON.stringify(objects[id])) : null);
        },
        getForeignObjectsAsync(pattern, type) {
            const regExp = patternToRegExp(pattern);
            const result = {};
            for (const [id, obj] of Object.entries(objects)) {
                if (regExp.test(id) && (!type || obj.type === type)) {
                    result[id] = JSON.parse(JSON.stringify(obj));
                }
            }
            return Promise.resolve(result);
        },
        getObjectListAsync(params) {
            const startkey = (params && params.startkey) || '';
            const endkey = (params && params.endkey) || '香';
            return Promise.resolve({
                rows: Object.values(objects)
                    .filter(obj => obj._id >= startkey && obj._id <= endkey)
                    .sort((a, b) => (a._id < b._id ? -1 : 1))
                    .map(obj => ({ id: obj._id, value: obj })),
            });
        },
        getObjectViewAsync(design, search, params) {
            if (design !== 'system') {
                return Promise.resolve({ rows: [] });
            }
            return Promise.resolve({ rows: rowsOfType(search, params) });
        },
        extendForeignObjectAsync(id, obj) {
            extended.push(id);
            const existing = objects[id] || {};
            objects[id] = {
                ...existing,
                ...obj,
                common: { ...existing.common, ...obj.common },
                native: { ...existing.native, ...obj.native },
            };
            return Promise.resolve({ id });
        },
        setForeignObjectAsync(id, obj) {
            objects[id] = { ...JSON.parse(JSON.stringify(obj)), _id: id };
            return Promise.resolve({ id });
        },
        delForeignObjectAsync(id, options) {
            delete objects[id];
            if (options && options.recursive) {
                for (const key of Object.keys(objects)) {
                    if (key.startsWith(`${id}.`)) {
                        delete objects[key];
                    }
                }
            }
            return Promise.resolve();
        },

        // --- states ---------------------------------------------------------
        getForeignStateAsync(id) {
            return Promise.resolve(states[id] ? { ...states[id] } : null);
        },
        getForeignStatesAsync(pattern, options) {
            const regExp = patternToRegExp(pattern);
            // Like js-controller: only the states of state objects, all states only in maintenance mode for admin
            const all = !!(options && options.maintenance && options.user === 'system.user.admin');
            const result = {};
            for (const [id, state] of Object.entries(states)) {
                if (regExp.test(id) && (all || (objects[id] && objects[id].type === 'state'))) {
                    result[id] = { ...state };
                }
            }
            return Promise.resolve(result);
        },
        setForeignStateAsync(id, value, ack) {
            states[id] = { val: value, ack: !!ack, ts: Date.now() };
            return Promise.resolve();
        },
        getHistoryAsync(id) {
            return Promise.resolve({
                result: [
                    { val: 20.5, ts: 1_750_000_000_000, ack: true },
                    { val: 21.5, ts: 1_750_000_060_000, ack: true },
                ],
                id,
            });
        },

        // --- files ----------------------------------------------------------
        readFileAsync(adapterName, fileName) {
            const content = files[adapterName] && files[adapterName][fileName];
            if (content === undefined) {
                return Promise.reject(new Error(`file not found: ${adapterName}/${fileName}`));
            }
            return Promise.resolve({ file: content, mimeType: 'application/json' });
        },
        writeFileAsync(adapterName, fileName, data) {
            files[adapterName] = files[adapterName] || {};
            files[adapterName][fileName] = data;
            return Promise.resolve();
        },
        readDirAsync(adapterName, dirName) {
            const storage = files[adapterName] || {};
            const prefix = dirName ? `${dirName}/` : '';
            const entries = Object.keys(storage)
                .filter(name => name.startsWith(prefix))
                .map(name => ({
                    file: name.substring(prefix.length),
                    isDir: false,
                    stats: { size: Buffer.byteLength(String(storage[name])) },
                    modifiedAt: 1_750_000_000_000,
                }));
            return Promise.resolve(entries);
        },
        fileExistsAsync(adapterName, fileName) {
            return Promise.resolve(!!(files[adapterName] && files[adapterName][fileName] !== undefined));
        },
        delFileAsync(adapterName, fileName) {
            if (files[adapterName]) {
                delete files[adapterName][fileName];
            }
            return Promise.resolve();
        },
        renameAsync(adapterName, oldName, newName) {
            const storage = files[adapterName] || {};
            if (storage[oldName] === undefined) {
                return Promise.reject(new Error(`file not found: ${adapterName}/${oldName}`));
            }
            storage[newName] = storage[oldName];
            delete storage[oldName];
            return Promise.resolve();
        },
        mkdirAsync(adapterName, dirName) {
            files[adapterName] = files[adapterName] || {};
            files[adapterName][`${dirName}/`] = '';
            return Promise.resolve();
        },

        // --- host / subscriptions -------------------------------------------
        sendToHost(host, command, message, callback) {
            if (command === 'getLogs') {
                callback(hostLogs.slice());
                return;
            }
            if (command === 'getNotifications') {
                callback({ result: JSON.parse(JSON.stringify(notifications)) });
                return;
            }
            if (command === 'clearNotifications') {
                messages.notificationsCleared.push({ host, ...message });
                callback({ result: 'ok' });
                return;
            }
            if (command === 'cmdExec') {
                // the host answers asynchronously with messages to the sending instance
                cmdExec.sent.push({ host, ...message });
                if (cmdExec.reply) {
                    setImmediate(() => {
                        adapter.emit('message', {
                            command: 'cmdStdout',
                            message: { id: message.id, data: `install ${message.data}` },
                        });
                        adapter.emit('message', {
                            command: 'cmdExit',
                            message: { id: message.id, data: cmdExec.exitCode },
                        });
                    });
                }
                return;
            }
            callback({ error: `unknown command ${command}` });
        },
        requireLog(enabled) {
            subscriptions.log.push(!!enabled);
            return Promise.resolve();
        },
        subscribeForeignStatesAsync(pattern) {
            subscriptions.states.push(pattern);
            return Promise.resolve();
        },
        unsubscribeForeignStatesAsync(pattern) {
            subscriptions.states = subscriptions.states.filter(one => one !== pattern);
            return Promise.resolve();
        },
        subscribeForeignObjectsAsync(pattern) {
            subscriptions.objects.push(pattern);
            return Promise.resolve();
        },
        unsubscribeForeignObjectsAsync(pattern) {
            subscriptions.objects = subscriptions.objects.filter(one => one !== pattern);
            return Promise.resolve();
        },
        sendToAsync(instance, command, message, options) {
            messages.sent.push({ instance, command, message, options });
            if (command === 'execute') {
                return Promise.resolve({
                    ok: true,
                    engineType: message.engineType || 'Javascript/js',
                    logs: [{ ts: 1, severity: 'info', message: `ran ${message.source}` }],
                    output: `ran ${message.source}`,
                });
            }
            return Promise.resolve({ echo: message });
        },
        supportsFeature(feature) {
            return feature === 'CONTROLLER_CMD_EXEC_FILES';
        },
        getSession() {
            return Promise.resolve(null);
        },

        // --- users ----------------------------------------------------------
        calculatePermissionsAsync(user) {
            return Promise.resolve(JSON.parse(JSON.stringify(permissions[user] || { user, groups: [] })));
        },
    };

    return {
        adapter,
        objects,
        states,
        files,
        logged,
        subscriptions,
        permissions,
        cmdExec,
        extended,
        messages,
        hostLogs,
    };
}

module.exports = { createMockAdapter, patternToRegExp };
