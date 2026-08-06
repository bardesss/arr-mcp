import { describe, expect, it } from 'vitest';
import { esc, html, humanBytes, raw, shortTime } from '../src/web/html.ts';

describe('escaping', () => {
    it('neutralises the characters that end a tag or an attribute', () => {
        expect(esc(`<script>alert('x')</script>`)).toBe(
            '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;'
        );
        expect(esc('a"b')).toBe('a&quot;b');
        expect(esc('a&b')).toBe('a&amp;b');
    });

    it('renders null and undefined as nothing, not as the words', () => {
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
    });
});

describe('the html template', () => {
    it('escapes every interpolation by default', () => {
        const evil = '<img src=x onerror=alert(1)>';
        expect(html`<p>${evil}</p>`.value).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    });

    // The escape hatch has to be visible at the call site, or it becomes the
    // accidental default.
    it('passes SafeHtml through untouched', () => {
        expect(html`<p>${raw('<b>bold</b>')}</p>`.value).toBe('<p><b>bold</b></p>');
    });

    it('joins arrays without separators, so rendered rows drop straight in', () => {
        const rows = [html`<li>a</li>`, html`<li>b</li>`];
        expect(html`<ul>${rows}</ul>`.value).toBe('<ul><li>a</li><li>b</li></ul>');
    });

    it('escapes inside an array too', () => {
        expect(html`<ul>${['<x>', '<y>']}</ul>`.value).toBe('<ul>&lt;x&gt;&lt;y&gt;</ul>');
    });

    // A release name from a public indexer is the most attacker-controllable
    // string in the system, and it reaches the audit view and the log table.
    it('is safe for a release name that tries to break out of an attribute', () => {
        const release = `Film.2026" onload="alert(1)`;
        const out = html`<td title="${release}">x</td>`.value;
        expect(out).not.toContain('onload="alert(1)"');
        expect(out).toContain('&quot;');
    });

    it('is safe for a fenced value, whose brackets are literal text', () => {
        const fenced = '<<untrusted:radarr.title>>Alien<</untrusted>>';
        expect(html`<td>${fenced}</td>`.value).toBe(
            '<td>&lt;&lt;untrusted:radarr.title&gt;&gt;Alien&lt;&lt;/untrusted&gt;&gt;</td>'
        );
    });
});

describe('formatting helpers', () => {
    it('scales bytes to something a person reads', () => {
        expect(humanBytes(0)).toBe('0 B');
        expect(humanBytes(1024)).toBe('1.0 KB');
        expect(humanBytes(25_900_000_000)).toBe('24.1 GB');
    });

    it('reports unknown sizes as unknown rather than as zero', () => {
        expect(humanBytes(undefined)).toBe('—');
        expect(humanBytes(Number.NaN)).toBe('—');
    });

    it('shortens an ISO timestamp for a log table', () => {
        expect(shortTime('2026-08-06T12:11:18.123Z')).toBe('2026-08-06 12:11:18');
    });
});
