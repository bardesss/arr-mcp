import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { registerAllPrompts } from '../src/mcp/prompts.ts';

/**
 * Prompts, read out of a real registration. What matters is not that the text
 * is any particular wording, but that it stays honest about the tools it
 * orchestrates and never crosses into instructing a write.
 */

// The SDK stores the callback as `handler` and calls it with (args, extra) —
// both confirmed by inspecting a real registration rather than assumed. The
// second argument is the request context, which these prompts never read.
type Registered = {
    argsSchema?: { shape?: Record<string, unknown> };
    handler: (
        args: Record<string, unknown>,
        extra: Record<string, unknown>
    ) => Promise<{ messages: { content: { text: string } }[] }>;
};

const registered = (): Record<string, Registered> => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerAllPrompts(server);
    return (server as unknown as { _registeredPrompts: Record<string, Registered> })._registeredPrompts;
};

const textOf = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
    (await registered()[name]!.handler(args, {})).messages[0]!.content.text;

const ALL = ['best_in_library', 'what_to_watch', 'whats_new', 'whats_wrong', 'why_not_playable'];
/** The SDK validates arguments before calling the handler, so a prompt with a
 *  required one has to be given it here. */
const MINIMUM_ARGS: Record<string, Record<string, unknown>> = { why_not_playable: { title: 'Alien' } };

const allTexts = (): Promise<string[]> => Promise.all(ALL.map(name => textOf(name, MINIMUM_ARGS[name] ?? {})));

/** Everything registerAllTools registers, as of 0.9. */
const TOOLS = new Set([
    'diagnose',
    'stack_health',
    'search_media',
    'get_media_details',
    'get_library',
    'get_queue',
    'get_calendar',
    'get_subtitles',
    'get_playback',
    'get_indexers',
    'get_requests',
    'lookup_media',
    'discover_media',
    'trigger_search',
    'remove_queue_item',
    'delete_media',
    'respond_to_request',
    'delete_request',
    'add_media'
]);

/** Backticked identifiers in prompt text that are parameters, not tools. */
const NOT_TOOLS = new Set([
    'certain',
    'has_file',
    'rating_source',
    'ratingCoverage',
    'watched',
    'limit',
    'kind',
    'query'
]);

describe('the prompts a client sees', () => {
    it('offers the five questions this stack gets asked', async () => {
        expect(Object.keys(registered()).sort()).toEqual(ALL);
    });

    it('takes the arguments each question needs', async () => {
        expect(Object.keys(registered().why_not_playable?.argsSchema?.shape ?? {})).toEqual(['title']);
        expect(Object.keys(registered().whats_wrong?.argsSchema?.shape ?? {})).toEqual([]);
        expect(Object.keys(registered().what_to_watch?.argsSchema?.shape ?? {})).toEqual(['kind']);
    });

    it('puts the argument it was given into the text', async () => {
        expect(await textOf('why_not_playable', { title: 'Alien' })).toContain('Alien');
        expect(await textOf('what_to_watch', { kind: 'series' })).toContain('"series"');
    });

    it('omits an optional argument rather than writing undefined into the text', async () => {
        expect(await textOf('what_to_watch')).not.toContain('undefined');
        expect(await textOf('whats_new')).toContain('7');
    });
});

/**
 * A prompt naming a tool that does not exist tells the model to call nothing,
 * and fails silently in the user's client. This is a live risk at 1.0, when the
 * audit renames things — the point of this test is that such a rename breaks
 * here, loudly, instead of there.
 */
describe('naming only tools that exist', () => {
    it('references no tool the server does not register', async () => {
        for (const text of await allTexts()) {
            for (const match of text.match(/`([a-z_]+)`/g) ?? []) {
                const name = match.replaceAll('`', '');
                if (!name.includes('_') || NOT_TOOLS.has(name)) continue;
                expect(TOOLS.has(name), `prompt names unknown tool \`${name}\``).toBe(true);
            }
        }
    });
});

/**
 * Write tools preview first and return a single-use token so a model cannot act
 * without the user seeing what it would do. A prompt that instructed a write
 * would route around that while looking like a convenience.
 */
describe('never instructing a write', () => {
    it('does not tell the model to call a write tool', async () => {
        for (const text of await allTexts()) {
            expect(text).not.toMatch(/\bcall `?(trigger_search|delete_media|add_media|remove_queue_item)`?/i);
        }
    });

    it('offers the one write it mentions, and says why it is not calling it', async () => {
        const text = await textOf('why_not_playable', { title: 'Alien' });
        expect(text).toMatch(/\*\*offer\*\*|offer/i);
        expect(text).toContain('Do not call it');
    });
});

/**
 * The two things this server genuinely cannot do. A prompt that stayed silent
 * about them invites the model to hallucinate a tool for each.
 */
describe('being honest about what it cannot reach', () => {
    it('says the write audit is not a tool', async () => {
        expect(await textOf('whats_wrong')).toContain('/ui/audit');
    });

    it('says nothing can trigger a library scan', async () => {
        expect(await textOf('whats_wrong')).toMatch(/no tool that triggers a library scan/i);
    });
});
