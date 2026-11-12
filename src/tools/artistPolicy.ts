import { ServiceError } from '../core/errors.ts';
import type { ArtistMonitorCapable, ArtistMonitorNewItems, ArtistMonitorPolicy, ServiceAdapter } from '../services/types.ts';
import { instancesOfType } from './resolveInstance.ts';
import type { WritePlan } from './write.ts';

/** How many artists sit at each new-album policy and each monitor flag, so a
 *  preview says what the library holds rather than only what it is about to
 *  become. The monitor-flag half is the "is this stable" read; the policy half
 *  is the "can it stop being stable again" read, and they are different
 *  questions with different answers. */
const tally = (policies: readonly ArtistMonitorPolicy[]): string => {
    const items = new Map<string, number>();
    const flags = new Map<string, number>();
    for (const p of policies) {
        items.set(p.monitorNewItems, (items.get(p.monitorNewItems) ?? 0) + 1);
        const flag = p.monitored ? 'monitored' : 'unmonitored';
        flags.set(flag, (flags.get(flag) ?? 0) + 1);
    }
    const group = (counts: Map<string, number>) =>
        [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => `${count} ${value}`).join(', ');

    // `artists`, not `albums`: the counts come from each artist's own monitor
    // flag, and printing them as albums is the exact mix-up the tool description
    // warns about. "new-album policy" stays, because `monitorNewItems` is an
    // album policy that an artist holds.
    return `new-album policy ${group(items)}; artists ${group(flags)}`;
};

/**
 * The artist ids the preview named, read back off the plan it signed.
 *
 * `apply` writes this list and does not read the library again: a second read
 * resolves "all artists" against a set that may have grown since the preview,
 * which is exactly the write this exists to prevent. The value is always there
 * — `plan` puts it in `args`, and the token is checked against those same args —
 * so a plan without it is a bug here rather than a caller mistake.
 */
const previewedArtistIds = (plan: WritePlan): string[] => {
    const ids = plan.args?.artist_ids;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
        throw new Error('The artist-level plan carried no artist list, so nothing was written.');
    }
    return ids;
};

type ArtistPolicyArgs = {
    instance?: string | undefined;
    artists?: string[] | undefined;
    monitored?: boolean | undefined;
    monitor_new_items?: ArtistMonitorNewItems | undefined;
};

/**
 * Preview of a monitoring policy over Lidarr artists, for update_media: the
 * named ones, or every artist when `artists` is absent.
 */
export async function planArtistPolicy(
    adapters: readonly ServiceAdapter[],
    adapter: ServiceAdapter & ArtistMonitorCapable,
    { instance, artists, monitored, monitor_new_items }: ArtistPolicyArgs
): Promise<WritePlan> {
    if (monitored === undefined && monitor_new_items === undefined) {
        throw new Error('Give `monitored`, `monitor_new_items`, or both. With neither there is nothing to change.');
    }

    const all = await adapter.listArtistMonitorPolicies();
    let targets: ArtistMonitorPolicy[];
    if (artists === undefined) {
        targets = all;
    } else {
        const byId = new Map(all.map(p => [p.artistId, p]));
        // Refused rather than dropped: the editor answers a list of ids
        // it cannot find with a 200, and a caller that mistyped one id
        // would go on believing that artist had been settled.
        const missing = artists.filter(aid => !byId.has(aid));
        if (missing.length > 0) {
            // Ids are per instance, and a get_library row for an
            // artist two Lidarrs hold carries one instance's id.
            const row =
                instancesOfType(adapters, 'lidarr').length < 2
                    ? 'a get_library artist row'
                    : `a get_library artist row whose acquisition.service is ${adapter.id}. Ids are per instance, and a row for an artist two Lidarrs hold may carry another instance's id, so take this one's from ${adapter.id} itself`;
            throw new ServiceError('NotFound', adapter.id, `Lidarr has no artist with id ${missing.join(', ')}`, {
                remedy: `Lidarr holds ${all.length} artists. Take an id from acquisition.id on ${row}.`
            });
        }
        targets = artists.map(aid => byId.get(aid)!);
    }

    if (targets.length === 0) {
        throw new ServiceError('NotFound', adapter.id, 'Lidarr reported no artists at all, so there is no policy to set', {
            remedy: 'Nothing was written. Check that this Lidarr actually holds artists.'
        });
    }

    const already = targets.filter(
        p =>
            (monitored === undefined || p.monitored === monitored) &&
            (monitor_new_items === undefined || p.monitorNewItems === monitor_new_items)
    );

    const scope = artists === undefined ? `all ${targets.length} artists` : `${targets.length} artist(s)`;
    const effects: string[] = [];
    if (monitor_new_items !== undefined) {
        effects.push(
            monitor_new_items === 'none'
                ? `Lidarr will not monitor any album it discovers for ${scope} from now on; the wanted list can no longer grow by itself.`
                : `Lidarr will keep monitoring new albums it discovers for ${scope}.`
        );
    }
    if (monitored !== undefined) {
        // The artist flag is not the album flag, and this was checked
        // rather than assumed: a live library was found with an artist
        // reading `monitored: false` while one album under it stayed
        // `monitored: true`. Lidarr's wanted lists, calendar, RSS sync
        // and missing and cutoff searches skip such an album
        // (`MissingController`, `CutoffController`, `AlbumsBetweenDates`,
        // `MonitoredAlbumSpecification` and `AlbumSearchService` check
        // the artist too; a search for one album by hand does not), but
        // its own flag is unchanged and comes back with the artist, so
        // the album level is named as the way to stop wanting one for
        // good.
        effects.push(
            monitored
                ? `Lidarr sets the artist-level monitor flag on ${scope}. This is not the album flag: each album keeps its own, and the monitored ones come back into Lidarr's wanted lists, calendar and automatic searches.`
                : `Lidarr clears the artist-level monitor flag on ${scope}. Their albums keep their own flags, but Lidarr leaves all of them out of its wanted lists, calendar and automatic searches until the artist is monitored again — use set_monitoring with level "album" to stop wanting one album for good. Files on disk are untouched either way.`
        );
    }
    effects.push(`State found before the change: ${tally(targets)}.`);

    const summary = [
        monitor_new_items === undefined ? undefined : `Set new-album monitoring to "${monitor_new_items}"`,
        monitored === undefined
            ? undefined
            : `${monitored ? 'Monitor' : 'Unmonitor'} at the artist level`
    ]
        .filter(Boolean)
        .join(' and ');

    return {
        target: `${adapter.id}:artists:${artists === undefined ? 'all' : [...artists].sort().join(',')}`,
        summary: `${summary} for ${scope} in ${adapter.id}.`,
        effects,
        args: {
            service: 'lidarr',
            ...(instance === undefined ? {} : { instance }),
            // The resolved set, never the word "all". The token is
            // signed over `args`, so an artist added between the
            // preview and the confirmation changes this list and the
            // token stops matching. That refuses a write into an
            // artist nobody was shown, instead of the apply re-reading
            // "all" and reaching it. It is also the record of which
            // artists the write named, which is the part an audit row
            // cannot reconstruct later.
            artist_ids: targets.map(p => p.artistId).sort(),
            ...(monitored === undefined ? {} : { monitored }),
            ...(monitor_new_items === undefined ? {} : { monitor_new_items })
        },
        ...(already.length === targets.length ? { noop: true } : {})
    };
}

/** Writes the artists the preview named, read back off the signed plan. */
export async function applyArtistPolicy(
    adapter: ServiceAdapter & ArtistMonitorCapable,
    plan: WritePlan,
    { monitored, monitor_new_items }: Pick<ArtistPolicyArgs, 'monitored' | 'monitor_new_items'>
): Promise<{ artists: number; monitored?: boolean; monitorNewItems?: ArtistMonitorNewItems }> {
    const ids = previewedArtistIds(plan);
    await adapter.setArtistMonitorPolicy(ids, {
        ...(monitored === undefined ? {} : { monitored }),
        ...(monitor_new_items === undefined ? {} : { monitorNewItems: monitor_new_items })
    });
    return {
        artists: ids.length,
        ...(monitored === undefined ? {} : { monitored }),
        ...(monitor_new_items === undefined ? {} : { monitorNewItems: monitor_new_items })
    };
}
