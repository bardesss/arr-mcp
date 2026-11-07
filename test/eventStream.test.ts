import { describe, expect, it } from 'vitest';
import { parseEventStream } from '../src/core/eventStream.ts';

describe('parseEventStream', () => {
    it('reads one JSON value per data event', () => {
        expect(parseEventStream('data:{"title":"A"}\n\ndata:{"title":"B"}\n\n')).toEqual([{ title: 'A' }, { title: 'B' }]);
    });
    it('joins a multi-line data event and ignores comments, ids and event names', () => {
        expect(parseEventStream(': hi\nid: 1\nevent: x\ndata:{"a":\ndata:1}\n\n')).toEqual([{ a: 1 }]);
    });
    it('skips an event that is not JSON and accepts CRLF', () => {
        expect(parseEventStream('data:oops\r\n\r\ndata:[1]\r\n\r\n')).toEqual([[1]]);
    });
    it('reads a last event that has no closing blank line', () => {
        expect(parseEventStream('data:{"title":"A"}\n\ndata:{"title":"B"}')).toEqual([{ title: 'A' }, { title: 'B' }]);
    });
});
