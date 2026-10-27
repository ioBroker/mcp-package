# @iobroker/mcp-server

MCP server for ioBroker

## Description

This adapter exposes ioBroker as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, so MCP-capable clients (e.g. Claude Desktop) can read and control your installation through a well-defined set of tools.

## Features

- MCP server over the **Streamable HTTP** transport (`/mcp` endpoint)
- Configurable HTTP/HTTPS web server
- Configurable port and bind address
- Optional authentication
- Optional SSL/TLS support
- Network diagnostics (ICMP ping / TCP probe) to troubleshoot adapter connections
- Adapter **repository** search to recommend installable adapters

## Operating modes

The adapter can run in two ways:

1. **Standalone** (default) – it starts its own web server on the configured port. The MCP endpoint is
   `http(s)://<host>:<port>/mcp`.
2. **Web extension** – it runs inside an existing [`web`](https://github.com/ioBroker/ioBroker.web) adapter
   instance and shares its web server (port, authentication, SSL). Select the target web instance in the
   admin configuration ("Extend WEB adapter"). The MCP endpoint is then served under the web adapter, e.g.
   `http(s)://<host>:8082/mcp/`.

   When a web instance is selected, the standalone server settings (port, bind address, authentication, SSL)
   are hidden because they are inherited from the chosen `web` instance.

## Configuration

The adapter can be configured through the ioBroker admin interface using JSONConfig:

### Server Configuration
- **Extend WEB adapter**: Select a `web` instance to run as its extension. Leave empty to run standalone.
- **Port**: The port on which the web server will listen (default: 8093) – standalone only
- **Bind Address**: IP address to bind the server to (0.0.0.0 for all interfaces) – standalone only

### Authentication
- **Enable Authentication**: When enabled (standalone mode), every request to the `/mcp` endpoint must
  present valid ioBroker credentials, otherwise it is rejected with `401 Unauthorized`. When disabled, the
  endpoint is reachable without credentials — only use that on a trusted network or behind a reverse proxy
  that provides its own authentication. As a **web extension** the host `web` instance's authentication
  applies instead, so this switch has no effect there.
- **Default User**: The ioBroker user whose permissions MCP requests run with when authentication is
  disabled (default: `admin`). With authentication enabled, every session runs with the permissions of the
  user who logged in, and this setting is not used. All object/state reads and writes performed by the tools
  are executed in the name of that user, so the user's ACLs are enforced. A plain name like `operator` is
  automatically expanded to `system.user.operator`. As a web extension the host `web` instance's default user
  applies. A session is bound to the user that opened it: requests of another user with the same session id
  are answered with `404 Session not found`.
- **Enable OAuth**: Offer the browser-based OAuth2 login that MCP clients such as Claude Desktop use when
  a connector is added. In standalone mode this requires *Enable Authentication*. As a **web extension**
  it also works, but the login is then provided by the host `web` instance, so OAuth has to be enabled
  **there as well** (web ≥ 9.1.0, "Allow third-party clients"). See below.
- **Public URL**: The externally reachable base URL of this server, e.g. `https://iobroker.example.com`.
  **Required behind a reverse proxy** — the URLs published in the OAuth discovery documents must be the
  ones the client can actually reach. When empty, they are derived from each incoming request.
- **Allow client self-registration**: Let MCP clients register themselves via RFC 7591 (default: **on**).
  With this off, every client has to be registered by hand before it can connect.

#### Connecting an MCP client via OAuth (recommended)

With **Enable OAuth** on, a client only needs the MCP endpoint URL. It discovers the rest by itself, the
user logs in and confirms in the browser, and the client never sees the ioBroker password:

1. The client requests `/mcp` and gets `401` with a `WWW-Authenticate` header pointing at
   `/.well-known/oauth-protected-resource/mcp` (RFC 9728).
2. From there it finds the authorization server and registers itself (RFC 7591).
3. The user's browser opens the ioBroker login and consent page, and the client redeems the resulting
   authorization code with PKCE (RFC 7636).

Two requirements are easy to miss:

- **HTTPS is mandatory** for anything but `localhost`. The flow runs through the user's browser, and MCP
  clients refuse plain `http://` for remote hosts. Enable SSL below or put the server behind an https
  reverse proxy.
- **Set the Public URL** when a reverse proxy is involved, otherwise the discovery documents advertise the
  internal address and the client cannot complete the flow.

Access tokens issued this way are bound to this server (RFC 8707): a token minted for some other service is
rejected with `error="invalid_token"`, even when it belongs to a valid ioBroker user. This matters most as a
web extension, where other resources on the same web server are authorized by the same login.

As a **web extension** the division of labour is: the host `web` instance runs the login, consent and token
endpoints, and this adapter publishes the metadata for its own endpoint under
`/.well-known/oauth-protected-resource/mcp` and verifies the audience. Enable OAuth in both — with it off in
`web`, unauthenticated MCP requests are answered with a redirect to the login page, which no MCP client can
use.

Users can disconnect a client at any time; the client's tokens can be dropped via `POST /oauth/revoke`.

#### Authenticating a client without OAuth (headless clients)
Clients may also authenticate in either of two ways:

- **HTTP Basic auth** — send an `Authorization: Basic <base64(user:password)>` header with every request
  (e.g. `curl -u mcpserver:secret ...`). Simplest for headless/script clients.
- **Bearer access token** — obtain a token once and send it as `Authorization: Bearer <access_token>`:

  ```bash
  curl -X POST https://HOST:PORT/oauth/token \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=password&client_id=ioBroker&username=mcpserver&password=secret'
  # → { "access_token": "...", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "..." }
  ```

Note that authentication only gates *access* to the endpoint; the tools still run with the **Default User's**
permissions regardless of which user authenticated. Give the Default User an ioBroker account with exactly
the ACLs the MCP client should have.

### Permissions
All options that change the system are **off** by default; turn on only what the MCP client really needs.

**States and objects**
- **Allow setting states**: Allow MCP clients to write state values and to acknowledge system notifications (the
  `set_state`, `set_states` and `clear_notifications` tools). Default: **on**. Which states can be written is
  decided by the ACLs of the Default User. `set_states` checks the write permission of all states first and writes
  nothing if one of them is not writable.
- **Mark setting states as destructive** (`setStateDestructive`): Declare `set_state` and `set_states` with
  `destructiveHint: true`, so MCP clients can warn before a state is written. Default: **on**. When off, both tools
  are declared as non-destructive writes (`readOnlyHint` stays `false`); whether a client still asks for
  confirmation then depends on the client.
- **Allow object/file changes** (`allowObjectChange`): Allow MCP clients to create/modify/delete objects, aliases
  and files (the `set_object`, `delete_object`, `create_state`, `create_scene`, `create_alias`, `write_file`,
  `delete_file`, `rename_file` and `mkdir` tools). Default: **off**.

**System**
- **Allow controlling instances** (`allowInstanceControl`): Start, stop and restart adapter instances and change
  their log level (`start_instance`, `stop_instance`, `restart_instance`, `set_log_level`). Default: **off**.
- **Allow managing adapters** (`allowAdapterManagement`): Add and delete instances and upgrade adapters from the
  repository (`add_instance`, `delete_instance`, `upgrade_adapter`). Default: **off**.
- **Allow changing scripts** (`allowScriptChange`): Create, change, start/stop and delete scripts of the
  javascript adapter and run code once (`set_script`, `enable_script`, `delete_script`, `run_script`). Reading
  scripts (`list_scripts`, `get_script`) is always possible. Scripts run with full access to ioBroker. Default:
  **off**.
- **Allow messages to adapters** (`sendToAllowlist`): Adapters (`telegram`) or instances (`backitup.0`) the
  `send_to` tool may send messages to, separated by commas; `*` allows all. Default: empty, then there is no
  `send_to` tool.

**Safety**
- **Ask for confirmation before dangerous actions** (`confirmDangerous`): MCP clients that support
  [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) ask the user before an
  object or instance is deleted, an instance stopped, an adapter upgraded or installed, a script saved or run, or a
  message sent. Clients without elicitation rely on the `destructiveHint` of the tools and their own confirmation.
  Default: **on**.
- **Allow download/upload links** (`transferLinks`): Tools may hand out short-lived links for data that is too large
  for an MCP message, see [Large results and files](#large-results-and-files). Default: **on**.

**Developers**
- **Allow installing packages (developers only)** (`allowPackageInstall`): Offer the `install_package` tool, which
  installs an adapter package on an ioBroker host - from npm, GitHub, a URL or a `.tgz` file - exactly like
  *Install from custom URL / file* in ioBroker.admin (`iobroker url ...`). Default: **off**. This option is only
  relevant for adapter developers, e.g. to let an AI agent build an adapter, pack it with `npm pack` and install the
  `.tgz` on a test system. An installed package runs with full rights on the host, so never enable it on a
  productive system or for clients you do not fully trust.

**Rights of the ioBroker user**
The options above decide which tools exist; what a call may do is decided by the rights of the ioBroker user the
MCP session runs as (the logged-in user, or the Default User without authentication), like in ioBroker.admin:
- the ACLs of objects, states and files for reading and writing them,
- the "other" rights of the user's groups: **execute** for commands on a host (`install_package`, `add_instance`,
  `delete_instance`, `upgrade_adapter`) and **sendto** for messages to adapters (`send_to`, `run_script`).
  Without them the call is refused before anything runs. Administrators have all rights.

A session is not even offered the tools that need a right the groups of its user lack: without the write right for
states no `set_state`/`set_states`, without the write right for objects no `set_object`, `create_state`,
`start_instance`, ..., without the delete right for states no `delete_orphan_states`, without the write right for
files no `write_file`, without **execute** no `install_package`,
without **sendto** no `send_to`. The rights are read when the session starts; every call is checked anyway.

`check_permissions` shows these rights and the ACLs of given objects.

**Log**
Every call of a changing tool is logged at info level with the user, the tool and its arguments
(`MCP system.user.admin: set_state(id="hue.0.light.state", value=true)`), and every failed call as a warning with
the same details. Long values are shortened; file contents, script code and `send_to` payloads are replaced by
their size.

### SSL/TLS Configuration
- **Enable HTTPS**: Enable HTTPS/SSL for secure connections
- **Public Certificate**: Path to the public certificate file
- **Private Key**: Path to the private key file
- **Chained Certificate**: Path to the chained certificate file (optional)

## MCP Endpoint

The MCP server is served at `POST/GET/DELETE /mcp` using the Streamable HTTP transport with per-session
state (tracked via the `Mcp-Session-Id` header). Sessions live in memory: requests with an unknown session ID
(e.g. after a restart of the adapter) are answered with `404 Not Found`, so the client starts a new session.
Point your MCP client at:

- standalone: `http(s)://<host>:<port>/mcp`
- web extension: `http(s)://<host>:<webPort>/mcp/`

### Available tools

| Tool                        | Description                                                                                                                                                                                                                                          |
|-----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `get_states`                | Retrieve the current value of one or multiple states; IDs may contain wildcards (e.g. `hue.0.*.brightness`); an ID without a state is returned with `exists: false` or a hint                                                                      |
| `wait_for_state`            | Wait until a state has a `value` (or, without `value`, until it is updated), optionally only with `ack`; gives up after `timeout` seconds (default 30, at most 50) with `reached: false`                                                             |
| `find_orphan_states`        | Find states without object (e.g. `system.adapter.vis.0.alive` of a deleted instance) by an ID `pattern`, except the upload progress `system.adapter.<adapter>.upload`, which has no object on purpose; delete them with `delete_orphan_states` or on the host with `iobroker state del <id>`|
| `get_object`                | Read a single object by its ID                                                                                                                                                                                                                       |
| `check_permissions`         | Show the user and groups of the MCP session, the rights of its groups and, for given object IDs, whether it may read/write/delete the object and read/write the state                                                                               |
| `search_objects`            | Search objects/states by keyword (matched against ID and name); optional filters for object `type`, `role`, `room` and source `adapter` instance                                                                                                     |
| `list_devices`              | List detected devices grouped by room (uses the ioBroker type-detector to expose functional devices with named controls); optional `language` and `room` filter                                                                                      |
| `list_instances`            | List adapter instances with their status                                                                                                                                                                                                             |
| `list_adapters`             | List installed adapters with metadata (version, title, description, keywords)                                                                                                                                                                        |
| `search_adapter_repository` | Search the ioBroker adapter **repository** (all *installable* adapters, not just installed ones) by keyword; optional `type` category, `onlyNotInstalled` and `language` filters — use it to recommend which adapter to install for a device/service |
| `list_hosts`                | List ioBroker hosts with their status                                                                                                                                                                                                                |
| `list_rooms`                | List rooms (`enum.rooms.*`) with localized names and member details; optional `language` and `withIcons`                                                                                                                                             |
| `list_functions`            | List functions (`enum.functions.*`) with localized names and member details; optional `language` and `withIcons`                                                                                                                                     |
| `history_query`             | Query historical values (requires a history adapter); aggregations: `raw`, `min`, `max`, `avg`, `sum`, `count`, `minmax`, `percentile`, `quantile`, `integral`                                                                                       |
| `read_file`                 | Read a file from an adapter file storage (optional base64); large files are read in chunks via `offset`/`length` (default 512 KiB per call) — the result carries `size`, `truncated` and `nextOffset`; `download: true` returns a download link instead |
| `list_files`                | List a directory in an adapter file storage                                                                                                                                                                                                          |
| `file_exists`               | Check whether a file exists in an adapter file storage                                                                                                                                                                                               |
| `get_logs`                  | Retrieve recent ioBroker log lines; optional filters by `level` (error/warn/info/debug), source `adapter`, start time (`from_ts`) and `search` in the message (text, or `/regex/flags`); `logFile` tells the time of the newest line and the file size                                                            |
| `write_log`                 | Write a message to the ioBroker log                                                                                                                                                                                                                  |
| `system_info`               | Get system and js-controller information                                                                                                                                                                                                             |
| `list_adapter_updates`      | List installed adapters that have a newer version in the active repository                                                                                                                                                                           |
| `list_notifications`        | List the system notifications of the hosts (the bell in admin): disk space, crashed adapters, ...                                                                                                                                                    |
| `list_scripts`              | List the scripts of the javascript adapter (without source)                                                                                                                                                                                          |
| `get_script`                | Read a script including its source                                                                                                                                                                                                                   |
| `ping_host`                 | Diagnose connectivity to a network device: ICMP ping to `host` plus an optional TCP connect to `port` — useful to investigate adapter `ETIMEDOUT`/connection errors                                                                                  |
| `set_state`                 | Set the value of a state (value coerced to the state type); with `wait_ack` (seconds) it waits until the device confirms the command (`ack: true`) and returns the confirmed state — requires *Allow setting states*                                 |
| `set_states`                | Set multiple states in one call (for scenes/group actions like "all lights off") — requires *Allow setting states*                                                                                                                                   |
| `clear_notifications`       | Acknowledge system notifications, optionally of one scope/category/instance — requires *Allow setting states*                                                                                                                                        |
| `set_object`                | Create/update an object (merges common/native) — requires *Allow object/file changes*                                                                                                                                                                |
| `delete_object`             | Delete an object, optionally with all children — requires *Allow object/file changes*                                                                                                                                                                |
| `delete_orphan_states`      | Delete states without object, given by their IDs or by patterns like `system.adapter.vis.0.*`; each state is checked again first, so a state with an object and the upload progress of an adapter are never deleted — requires *Allow object/file changes* |
| `create_state`              | Create a new state object with type/role/unit/min/max and optional initial value — requires *Allow object/file changes*                                                                                                                              |
| `create_scene`              | Create or update a scene for the ioBroker `scenes` adapter (state/value pairs applied together) — requires *Allow object/file changes*                                                                                                               |
| `create_alias`              | Create an alias (`alias.0.*`) pointing to a state, optionally with a separate write state — requires *Allow object/file changes*                                                                                                                     |
| `write_file`                | Write a file to an adapter file storage, from `content` or from a file uploaded via `prepare_upload` (`upload_id`) — requires *Allow object/file changes*                                                                                              |
| `delete_file`               | Delete a file from an adapter file storage — requires *Allow object/file changes*                                                                                                                                                                    |
| `rename_file`               | Rename/move a file within the same adapter file storage — requires *Allow object/file changes*                                                                                                                                                       |
| `mkdir`                     | Create a directory in an adapter file storage — requires *Allow object/file changes*                                                                                                                                                                 |
| `prepare_upload`            | Get a one-time upload link for a file that is too large for a tool argument (e.g. a `.tgz`), for clients that can run shell commands — requires *Allow download/upload links* and *Allow object/file changes* or *Allow installing packages*           |
| `install_package`           | Install an adapter package (npm, GitHub, URL, `.tgz` from the file storage, as base64 or uploaded via `prepare_upload`) on a host, restart its enabled instances and report whether they came up, with their first log lines — requires *Allow installing packages*, developers only |
| `start_instance`            | Start (enable) an instance — requires *Allow controlling instances*                                                                                                                                                                                  |
| `stop_instance`             | Stop (disable) an instance — requires *Allow controlling instances*                                                                                                                                                                                  |
| `restart_instance`          | Restart a running instance — requires *Allow controlling instances*                                                                                                                                                                                  |
| `set_log_level`             | Change the log level of an instance, temporarily or persistently — requires *Allow controlling instances*                                                                                                                                            |
| `add_instance`              | Create an instance of an adapter from the repository (`iobroker add`) — requires *Allow managing adapters*                                                                                                                                           |
| `delete_instance`           | Delete an instance with its objects and states (`iobroker del`) — requires *Allow managing adapters*                                                                                                                                                 |
| `upgrade_adapter`           | Upgrade an adapter to the repository or a given version (`iobroker upgrade`) — requires *Allow managing adapters*                                                                                                                                    |
| `set_script`                | Create a JavaScript/TypeScript script or change its source — requires *Allow changing scripts*                                                                                                                                                       |
| `enable_script`             | Start or stop a script — requires *Allow changing scripts*                                                                                                                                                                                           |
| `delete_script`             | Delete a script — requires *Allow changing scripts*                                                                                                                                                                                                  |
| `run_script`                | Run code once in the javascript adapter and return its log output (javascript ≥ 10.1.0) — requires *Allow changing scripts*                                                                                                                          |
| `send_to`                   | Send a message to an adapter instance (`sendTo`) and return the answer — only instances in *Allow messages to adapters*                                                                                                                              |

All object/state access runs with the permissions of the user of the session (the logged-in user or the
configured **Default User**). The write tools are only registered when their respective permission option is
enabled, and only offered to users whose groups have the rights they need.

Every tool declares a JSON input schema and all four MCP behaviour hints (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`), so a host can tell what a tool does before calling it and can ask the user
for confirmation before a writing tool runs. All reading tools are `readOnlyHint: true`; `ping_host` is the only
tool with `openWorldHint: true`, because it talks to hosts outside of ioBroker.

### Large results and files
MCP clients reject tool results above 1 MiB, and a model cannot pass megabytes of base64 as a tool argument. So:

- **Every result stays below the limit.** Lists (`get_states`, `search_objects`, `list_files`, `list_scripts`,
  `history_query`) return as many entries as fit and add `truncated`, `total`, `nextOffset` and a `hint`; call
  again with `offset` set to `nextOffset` for the next part. `get_logs` keeps the newest lines. Any other result
  that is too large is replaced by a download link, or by an error asking to narrow the request down.
- **Download links** (`download_url`): a cut list carries a link to all of its entries as JSON, and `read_file`
  with `download: true` returns a link to the whole file. Clients that can run shell commands (e.g. Claude Code)
  fetch it with `curl -o <file> "<download_url>"`.
- **Upload links**: `prepare_upload` returns a link and an `upload_id`. The client uploads the file with
  `curl -T <file> "<url>"` (`PUT` or `POST`, raw body, up to 100 MB) and passes the `upload_id` to `write_file` or
  `install_package`. A link can be used once.

The links are `<mcp endpoint>/transfer/<token>`: the random token is the credential, so they work without the
login of the MCP endpoint, and they expire after 15 minutes. They are built from the address the client used, or
from *Public URL*. They are not available in-process (ioBroker.admin) and as a web extension with authentication
enabled in the web adapter, because the web adapter asks for a login first; the tools then say so.

### Prompts
MCP clients offer these as ready-made commands (e.g. as slash commands):

- `diagnose_adapter` (`instance`) - find out why an instance does not work: status, log, notifications,
  connectivity and available updates.
- `room_overview` (`room`) - summary of the devices of a room and anything unusual.
- `create_automation` (`description`) - turn a description into a script for the javascript adapter.

### Resources & live updates (SSE)

States and objects are also exposed as MCP **resources** using the canonical ioBroker URI scheme, so clients
can read and **subscribe** to them. The server pushes changes over the Streamable HTTP SSE stream
(`notifications/resources/updated`).

- States: `iobstate://<id>` (e.g. `iobstate://javascript.0.temperature`) – `resources/read` returns
  `{ id, val, ack, ts, lc, q }`.
- Objects: `iobobject://<id>` (e.g. `iobobject://system.adapter.admin.0`) – `resources/read` returns the object.
- Logs: `ioblog://all` (every source) or `ioblog://<source>` (e.g. `ioblog://admin.0`) – `resources/read`
  returns the recent log lines (`{ source, logs: [{ ts, level, source, message }] }`). Subscribing enables
  log forwarding for the adapter; each new matching line triggers a `notifications/resources/updated`.
- `resources/subscribe` subscribes to the underlying ioBroker state/object/log; on every change the client
  receives a `notifications/resources/updated` for that URI and re-reads it. `resources/unsubscribe` stops it.

Subscriptions are tracked per session and ref-counted, so the adapter subscribes to a state/object only once
regardless of how many clients/sessions watch it, and unsubscribes when the last one leaves.

(Files use `iobfile://<adapter>/<path>` in the same scheme; they are available via the `read_file`/`write_file`
tools rather than as subscribable resources.)

### Health endpoints (non-MCP)

- `GET /` - Basic server information
- `GET /status` - Server status, uptime and active session count
- `GET /api/info` - Adapter information

## Development

```bash
npm run build   # compile src/ to build/
npm run lint
npm test        # builds, then runs the unit tests in test/
```

The unit tests drive the server through a real MCP client over an in-memory transport
(`createInProcessMcp`) on top of a mock ioBroker adapter, so every declared tool is called the way an MCP
client calls it and its result is verified:

- `test/toolMetadata.test.js` guards the advertised contract - the exact set of tools, a title, a description,
  an input schema and the four behaviour hints on every one of them, and the permission gating.
- `test/tools.test.js` exercises the behaviour of each tool (including the error paths and the input
  validation) against `test/mockAdapter.js`.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
* (@GermanBluefox) Added the `delete_orphan_states` tool: deletes the states without object found by `find_orphan_states`, but never a state with an object

### 1.8.1 (2026-10-26)
* (@GermanBluefox) `find_orphan_states` no longer reports the upload progress of the adapters (`system.adapter.<adapter>.upload`), which js-controller writes without object on purpose

### 1.8.0 (2026-10-26)
* (@GermanBluefox) Security: commands on a host (`install_package`, `add_instance`, `delete_instance`, `upgrade_adapter`) require the "execute" right of the user, messages to adapters (`send_to`, `run_script`) the "sendto" right, like in admin. Before, they ran with the rights of the adapter
* (@GermanBluefox) `install_package` reports a done installation even if the instances could not be restarted afterwards (`restartError`), instead of failing
* (@GermanBluefox) Every call of a changing tool is logged with the user, the tool and its arguments; a failed call names the tool and its arguments
* (@GermanBluefox) `get_logs` searches the messages for a text or a regular expression (`search`)
* (@GermanBluefox) A session is only offered the tools its user has the rights for, e.g. no `install_package` without "execute"
* (@GermanBluefox) `set_state` waits for the confirmation of the device with `wait_ack` and returns the confirmed state
* (@GermanBluefox) Added the `wait_for_state` tool: waits until a state has a value or is updated
* (@GermanBluefox) Added the `find_orphan_states` tool: finds states without object, e.g. of deleted instances

### 1.7.1 (2026-10-26)
* (@GermanBluefox) Fixed: `get_logs` always returned `size: null` for the log file, because the host sends the size as a string

### 1.7.0 (2026-10-26)
* (@GermanBluefox) A confirmation that the client dismissed without an answer is no longer reported as "Cancelled by the user", but explains how to turn off the confirmations for clients that cannot show them
* (@GermanBluefox) `get_states` returns `exists: false` for an unknown ID instead of a `null` value with the current time
* (@GermanBluefox) A wrong password is logged with the address and the User-Agent of the client
* (@GermanBluefox) `get_logs` returns the time of the newest line and the size of the log file, to see when the log is no longer written
* (@GermanBluefox) Added the `check_permissions` tool: what the user of the MCP session may do with an object
* (@GermanBluefox) `install_package` reports whether the restarted instances came up again and their first log lines

### 1.6.1 (2026-10-24)
* (@GermanBluefox) An upload can only be used by the user that created it with `prepare_upload`

### 1.6.0 (2026-10-24)
* (@GermanBluefox) With authentication, the tools run with the permissions of the logged-in user instead of the default user; a session can only be used by the user that opened it
* (@GermanBluefox) As a web extension, the default user of the `web` instance is used

### 1.5.1 (2026-10-24)
* (@GermanBluefox) Transfer folders left behind by a killed process are removed at startup

### 1.5.0 (2026-10-24)
* (@GermanBluefox) Tool results are kept below the 1 MiB limit of MCP clients: lists are paged with `offset`, other results are replaced by a download link
* (@GermanBluefox) Added download links (`read_file` with `download: true`, complete lists) and upload links (`prepare_upload`, used by `write_file` and `install_package`) for large data (option `transferLinks`)

### 1.4.0 (2026-10-23)
* (@GermanBluefox) Added tools to control instances, manage adapters, read/change/run scripts, read and acknowledge notifications, create aliases and send messages to adapters, each behind its own option (off by default)
* (@GermanBluefox) Added the prompts `diagnose_adapter`, `room_overview` and `create_automation`
* (@GermanBluefox) Dangerous actions ask the user for a confirmation if the client supports elicitation (option `confirmDangerous`)

### 1.3.0 (2026-10-23)
* (@GermanBluefox) Added the `install_package` tool (opt-in `allowPackageInstall`, only for developers): installs an adapter package from npm, GitHub, a URL or a `.tgz` file on a host

### 1.2.3 (2026-10-19)
* (@GermanBluefox) updated packages

### 1.2.0 (2026-10-19)
* (@Garfonso) Fixed: with "Allow object/file changes" enabled, MCP clients received no tools at all when the MCP SDK uses a different zod copy; omitted tool arguments with a default are no longer rejected (ioBroker/ioBroker.mcp#70)
* (@GermanBluefox) `set_states` checks the write permission of all states before writing and rejects the whole call if one of them may not be written by the Default User (ioBroker/ioBroker.mcp#71)

### 1.1.3 (2026-09-15)
* (@GermanBluefox) Requests with an unknown `Mcp-Session-Id` (e.g. after a restart) are answered with `404 Not Found` instead of `400`, so MCP clients start a new session as required by the Streamable HTTP specification

### 1.1.2 (2026-09-15)
* (@GermanBluefox) New option `setStateDestructive` (default true): `set_state`/`set_states` can be declared as non-destructive writes

### 1.1.1 (2026-09-15)
* (@GermanBluefox) No "MCP authentication is disabled" warning when the standalone server is bound to a loopback address (`127.0.0.1`, `::1`, `localhost`)

### 1.1.0 (2026-09-11)
* (@GermanBluefox) Every tool now declares all four MCP behaviour hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and a human-readable title, so hosts can warn before a writing tool is invoked
* (@GermanBluefox) `system_info`, `list_instances` and `list_hosts` declare an explicit (empty) input schema
* (@GermanBluefox) The embedded in-process client now exposes the `title` and `annotations` of every tool
* (@GermanBluefox) Fixed the JSDoc of the embedded `allowSetState` option: state writing is opt-out (default true), not opt-in
* (@GermanBluefox) Added unit tests that call every declared tool over a real MCP client/server pair

### 1.0.3 (2026-09-03)
* (@GermanBluefox) `read_file` reads large files in chunks: new optional `offset`/`length` parameters, at most 512 KiB per call by default; the result now contains `size`, `offset`, `length`, `truncated` and `nextOffset` (MCP clients reject tool results above 1 MB, ioBroker/ioBroker.mcp#63)

### 1.0.2 (2026-09-03)
* (@GermanBluefox) Updated packages

### 1.0.1 (2026-08-04)
* (@GermanBluefox) Added OAuth support: MCP clients can now connect through a browser login instead of a manually created token
* (@GermanBluefox) OAuth also works as a web extension, using the host `web` instance as the authorization server
* (@GermanBluefox) Access tokens are checked against the resource they were issued for (RFC 8707)
* (@GermanBluefox) Requires `@iobroker/webserver` 2.0.1

### 0.1.6 (2026-07-10)
* (@GermanBluefox) Added `fillLevel`

### 0.1.5 (2026-07-04)
* (@GermanBluefox) Better rooms and name resolution

### 0.1.2 (2026-07-02)
* (@GermanBluefox) Fixed authentication: with "Enable Authentication" on, the standalone MCP endpoint now
  requires valid ioBroker credentials (Bearer token or HTTP Basic auth) and rejects anonymous requests with
  `401 Unauthorized` (#44)

### 0.0.2 (2026-06-17)
* (@GermanBluefox) Initial development

## License

MIT License

Copyright (c) 2026 ioBroker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
