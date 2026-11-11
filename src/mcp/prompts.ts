import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { WRITE_TOOLS } from '../tools/register.ts';
import { toolUsable, type SurfaceOptions } from './toolSurface.ts';

/**
 * The five questions this stack actually gets asked (0.9 spec ).
 *
 * **A prompt orchestrates tools and adds no capability.** That is what makes
 * this phase safe on a client that does not surface prompts: every sequence
 * below is one the model could have assembled itself, so what is lost is
 * discoverability, never reach. Forty tool names and no indication of which
 * question to ask is the problem this solves.
 *
 * **No prompt may instruct a write.** It may *offer* one. Write tools preview
 * first and hand back a single-use token precisely so a model cannot act
 * without the user seeing what it would do, and a prompt that walked straight
 * into a write would route around that while looking like a convenience.
 *
 * **These names are public surface.** A client that has surfaced `whats_wrong`
 * as a slash command breaks if it is renamed, exactly as a saved prompt breaks
 * when a tool is renamed — so they are `snake_case` like the tools, and the
 * 1.0 audit freezes them on the same terms.
 */

const MAX_WINDOW_DAYS = 36_500;

const user = (text: string) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }]
});

/** One line of a numbered list; `tool` is the tool it sends the model to, if any. */
type PromptStep = { tool?: string; text: string };

/**
 * The steps whose tool the client can still see, numbered from 1. A step that
 * names a tool `hide_unusable` removed would send the model to a call that
 * does not exist.
 */
function numbered(steps: readonly PromptStep[], surface: SurfaceOptions): string {
    return steps
        .filter(s => s.tool === undefined || toolUsable(s.tool, surface, WRITE_TOOLS.has(s.tool)))
        .map((s, i) => `${i + 1}. ${s.text}`)
        .join('\n');
}

// Built once and shared by every request's server (#573).
const WhyNotPlayableArgs = z.object({ title: z.string().min(1).describe('The film, series or artist to explain.') });
const NoArgs = z.object({});
const KindArgs = z.object({
    kind: z.enum(['movie', 'series']).optional().describe('Films or series. Omit for both.')
});
const WhatsNewArgs = z.object({
    days: z.string().optional().describe('How many days back. Defaults to 7.')
});

export function registerAllPrompts(server: McpServer, surface: SurfaceOptions): void {
    server.registerPrompt(
        'why_not_playable',
        {
            title: 'Why is this not playable?',
            description:
                'Walk the whole chain for one title — requested, managed, monitored, downloaded, indexed, imported, scanned — and name the first thing that explains it.',
            argsSchema: WhyNotPlayableArgs
        },
        ({ title }) =>
            user(
                `Work out why "${title}" is not playable.

1. Call \`diagnose_media\` with \`query: "${title}"\`. It walks the whole chain and names the first step that explains the absence, rather than listing everything it checked.
2. If the verdict has \`certain: false\`, say plainly which step could not be checked and why — a confident answer across a hole is worse than an uncertain one.
3. If the verdict has \`next_steps\`, it names the call that acts on the remedy. **Offer** it and say what it would do. Do not call it. A write previews first and returns a token for a reason: the user decides whether to act.
4. If \`diagnose_media\` reports the item is missing entirely, use \`search_media\` with \`source: "discover"\` to check it exists at all before suggesting anything be added.

Answer with the cause and the next action, not a transcript of the checks.`
            )
    );

    server.registerPrompt(
        'whats_wrong',
        {
            title: 'What needs my attention?',
            description:
                'The periodic sweep: what is broken, stuck, out of disk, not scanning, or missing subtitles — reconciled into a short list of things that actually need you.',
            argsSchema: NoArgs
        },
        () =>
            user(
                `Sweep the stack and tell me what needs me. In order:

${numbered(
    [
        { tool: 'get_stack_health', text: '`get_stack_health` — unreachable services, failing health checks, disks running out, libraries that have not been scanned recently.' },
        { tool: 'get_queue', text: '`get_queue` — anything stalled, failed, or sitting at 0% across every download client.' },
        { tool: 'get_indexers', text: '`get_indexers` — indexers that are unhealthy or recently rejecting.' },
        { tool: 'get_subtitles', text: '`get_subtitles` — what is missing subtitles, and which providers are throttled.' }
    ],
    surface
)}

${toolUsable('get_indexers', surface, WRITE_TOOLS.has('get_indexers')) ? 'Then reconcile: a stalled download and an unhealthy indexer are usually one problem, not two. Say so rather than listing both.\n\n' : ''}Report only what needs action, most urgent first, with what to do about each. If nothing does, say that in one line — do not pad it with everything that is fine.

One thing you cannot see, so do not claim to: the write audit is not exposed as a tool and lives in the config UI at /ui/audit.${toolUsable('trigger_scan', surface, true) ? ' If a stale scan is the problem, offer `trigger_scan` and say what it would do.' : ''}`
            )
    );

    server.registerPrompt(
        'what_to_watch',
        {
            title: 'What should I watch?',
            description:
                'Unwatched, well rated, and actually on disk — plus anything half-finished worth continuing.',
            argsSchema: KindArgs
        },
        ({ kind }) =>
            user(
                `Recommend something to watch tonight.

${numbered(
    [
        { tool: 'get_library', text: `\`get_library\` with \`watched: false\`, \`has_file: true\`${kind === undefined ? '' : `, \`kind: "${kind}"\``}, \`rating_source: "imdb"\`, \`sort: "rating"\` and a small \`limit\`. \`has_file: true\` matters — recommending something not downloaded wastes the answer.` },
        { tool: 'get_playback', text: '`get_playback` — anything part-watched is usually a better suggestion than something new.' },
        { text: 'If `ratingCoverage` reports many unrated items, say so. It means the ranking saw less of the library than it looks like, and it usually means the IMDb dataset is off or still ingesting.' }
    ],
    surface
)}

Give a handful of suggestions with one line each on why. Rank them; do not just list what came back.`
            )
    );

    server.registerPrompt(
        'best_in_library',
        {
            title: 'What is the best thing I own?',
            description: 'Rank everything in the library by rating, watched or not.',
            argsSchema: KindArgs
        },
        ({ kind }) =>
            user(
                `Rank my library by rating.

Call \`get_library\` with \`rating_source: "imdb"\`, \`sort: "rating"\`${kind === undefined ? '' : `, \`kind: "${kind}"\``} and a small \`limit\`. Unlike a recommendation this includes what I have already watched — it is an inventory question, not a suggestion.

Report \`ratingCoverage\`: how many carry no IMDb rating and so could not be ranked at all. An unrated title is not a bad title, and a top ten drawn from half the library should say so.

For a series, \`rating_source: "imdb"\` is worth naming explicitly — the default for series is \`tvdb\`, which is a different number on a different scale.`
            )
    );

    server.registerPrompt(
        'whats_new',
        {
            title: 'What happened this week?',
            description: 'A digest: what arrived, what aired, what finished downloading and what failed.',
            argsSchema: WhatsNewArgs
        },
        ({ days }) => {
            // A window the model cannot parse falls back to the default rather
            // than reaching the text as "last soon days".
            // Capped, because a date past about 1e8 days back is not a date and `toISOString` throws on it.
            const parsed = Number(days);
            const window = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_WINDOW_DAYS) : 7;
            // get_history compares `since` as a plain string against each
            // record's own date, so a full ISO timestamp is the right shape.
            const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000).toISOString();
            return user(
                `Summarise the last ${window} days.

${numbered(
    [
        { tool: 'get_library', text: '`get_library` with `sort: "added"` and a small `limit` — what arrived, newest first. Items no *arr manages carry no added date and are left out; that is expected, not an error.' },
        { tool: 'get_calendar', text: '`get_calendar` — what aired or is due.' },
        { tool: 'get_history', text: `\`get_history\` with \`since: "${since}"\` — what imported and what failed. A failure carries the download client's own message, so say what it was.` },
        { tool: 'get_queue', text: '`get_queue` — what is still in flight.' }
    ],
    surface
)}

Write it as a digest a person would read: counts first, then anything that went wrong. Do not list every episode.`
            );
        }
    );
}
