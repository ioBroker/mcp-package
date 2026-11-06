/** Shared byte-window implementation for adapter files and serialized objects. */
export function readWindow(
    buffer: Buffer,
    asText: boolean,
    offset: number,
    length: number,
): {
    encoding: 'utf8' | 'base64';
    content: string;
    size: number;
    offset: number;
    length: number;
    truncated: boolean;
    nextOffset?: number;
} {
    const size = buffer.length;
    let start = Math.min(Math.max(0, Math.floor(offset)), size);
    let end = Math.min(start + Math.max(1, Math.floor(length)), size);
    if (asText) {
        // Never split a multibyte UTF-8 sequence: continuation bytes are 0b10xxxxxx.
        const isContinuation = (i: number): boolean => (buffer[i] & 0xc0) === 0x80;
        while (start < end && isContinuation(start)) {
            start++;
        }
        while (end > start && end < size && isContinuation(end)) {
            end--;
        }
        if (end === start && start < size) {
            // Return at least one whole character to guarantee progress.
            end = start + 1;
            while (end < size && isContinuation(end)) {
                end++;
            }
        }
    }
    const chunk = buffer.subarray(start, end);
    const truncated = end < size;
    return {
        encoding: asText ? 'utf8' : 'base64',
        content: chunk.toString(asText ? 'utf8' : 'base64'),
        size,
        offset: start,
        length: chunk.length,
        truncated,
        ...(truncated ? { nextOffset: end } : {}),
    };
}
