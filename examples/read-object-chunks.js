'use strict';
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Read-only client example. callGetObject(args) returns the standard MCP tools/call result.
 * expectedSource must be independently obtained bytes, e.g. git show <PRIMARY-SHA>:<source-path>.
 * Nothing is returned (or written) until the entire object and optional source comparison pass.
 */
async function readObjectChunks(callGetObject, id, { expectedSource, maxBytes = 64 * 1024 * 1024 } = {}) {
    if (
        typeof id !== 'string' ||
        !id ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        (expectedSource !== undefined && !Buffer.isBuffer(expectedSource))
    ) {
        throw new Error('Invalid read options');
    }
    let offset = 0;
    let sha256;
    let size;
    const chunks = [];
    for (;;) {
        const args = { id, offset, ...(sha256 ? { sha256 } : {}) };
        const result = await callGetObject(args);
        if (
            !result ||
            (result.isError !== undefined && result.isError !== false) ||
            !Array.isArray(result.content) ||
            result.content.length !== 1 ||
            result.content[0].type !== 'text' ||
            typeof result.content[0].text !== 'string'
        ) {
            throw new Error('Object chunk call failed');
        }
        const envelope = JSON.parse(result.content[0].text);
        const page = envelope?.data;
        const fields = ['id', 'sha256', 'encoding', 'content', 'size', 'offset', 'length', 'truncated', 'nextOffset'];
        if (
            envelope.ok !== true ||
            !page ||
            Object.keys(envelope).some(k => !['ok', 'data'].includes(k)) ||
            Object.keys(page).some(k => !fields.includes(k)) ||
            page.id !== id ||
            page.encoding !== 'base64' ||
            typeof page.sha256 !== 'string' ||
            !digestPattern.test(page.sha256) ||
            !Number.isSafeInteger(page.size) ||
            page.size < 1 ||
            page.size > maxBytes ||
            page.offset !== offset ||
            !Number.isSafeInteger(page.length) ||
            page.length < 1 ||
            page.length > 512 * 1024 ||
            page.offset + page.length > page.size ||
            typeof page.content !== 'string' ||
            typeof page.truncated !== 'boolean'
        ) {
            throw new Error('Invalid object chunk');
        }
        if (sha256 !== undefined && (page.sha256 !== sha256 || page.size !== size)) {
            throw new Error('Object changed during read');
        }
        sha256 = page.sha256;
        size = page.size;
        const bytes = Buffer.from(page.content, 'base64');
        if (bytes.toString('base64') !== page.content || bytes.length !== page.length) {
            throw new Error('Invalid chunk bytes');
        }
        const end = offset + bytes.length;
        if (page.truncated !== end < size || (page.truncated ? page.nextOffset !== end : own(page, 'nextOffset'))) {
            throw new Error('Incomplete or overlapping object chunks');
        }
        chunks.push(bytes);
        offset = end;
        if (!page.truncated) {
            break;
        }
    }
    const bytes = Buffer.concat(chunks, size);
    if (offset !== size || hash(bytes) !== sha256) {
        throw new Error('Object SHA-256 mismatch');
    }
    const object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object || typeof object !== 'object' || Array.isArray(object) || object._id !== id) {
        throw new Error('Object identity mismatch');
    }
    const source = object.common?.source;
    const sourceBytes = typeof source === 'string' ? Buffer.from(source, 'utf8') : undefined;
    if (expectedSource !== undefined && (!sourceBytes || !sourceBytes.equals(expectedSource))) {
        throw new Error('Runtime source differs from PRIMARY');
    }
    return {
        object,
        bytes,
        sha256,
        chunks: chunks.length,
        sourceBytes,
        sourceSha256: sourceBytes ? hash(sourceBytes) : undefined,
    };
}

module.exports = { readObjectChunks };
