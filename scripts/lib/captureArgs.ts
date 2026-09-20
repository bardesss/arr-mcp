import { ServiceIdSchema, type ServiceId } from '../../src/config/schema.ts';

/**
 * Which services `npm run capture` should touch, from the arguments after
 * `--`. Undefined means all of them, which is the maintainer refresh the
 * script was written for.
 *
 * The filter exists because the unfiltered run is the wrong shape for the
 * person most likely to be asked for a capture. A volunteer capturing one
 * service gets a diff rewriting fixtures for every other service they happen
 * to run, carrying their own data, and has to know which files to discard.
 *
 * An unknown id throws rather than selecting nothing: the script writes no
 * file for a service it never matched, so a silent empty selection is
 * indistinguishable from a server that answered nothing.
 */
export function parseServiceFilter(args: readonly string[]): ServiceId[] | undefined {
    const named = args.filter(a => !a.startsWith('-'));
    if (named.length === 0) return undefined;

    const unknown = named.filter(a => !ServiceIdSchema.safeParse(a).success);
    if (unknown.length > 0) {
        throw new Error(
            `unknown service ${unknown.join(', ')}. Valid: ${ServiceIdSchema.options.join(', ')}`
        );
    }

    return named as ServiceId[];
}
