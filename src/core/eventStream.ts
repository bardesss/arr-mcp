/**
 * The JSON values in a `text/event-stream` body, one per event. Grimmory's
 * prospective metadata answers this way, and the whole body is read before it
 * is parsed: the call ends when the stream does.
 *
 * An event is the lines up to a blank line; its `data:` lines are joined with a
 * newline. Comments, ids and event names carry nothing the adapter reads, and an
 * event whose data is not JSON is skipped.
 */
export function parseEventStream(text: string): unknown[] {
    const values: unknown[] = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).replace(/^ /, ''));
        if (data.length === 0) continue;
        try {
            values.push(JSON.parse(data.join('\n')) as unknown);
        } catch {
            // Not JSON: skip it rather than fail the whole stream.
        }
    }
    return values;
}
