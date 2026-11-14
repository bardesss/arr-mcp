/**
 * Disk sizes as people read them. Powers of 1024, so the units are the binary
 * ones: calling 1024³ bytes a GB put every figure about 7% away from a decimal
 * reading of the same disk.
 */
export function humanBytes(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes)) return 'n/a';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    // One decimal below 100 in any scaled unit: "24.1 GiB" is the difference
    // between two films and three, and "512 KiB" gains nothing from ".0".
    return `${unit > 0 && value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What a service reports about one mount; `services/types` DiskSpace has this shape. */
type Mount = { service: string; freeSpace: number; totalSpace?: number | undefined; label?: string; path?: string };

/** `mounts` names each mount the group was seen at, `radarr /config`, or the service alone when it gave no name. */
export type DiskGroup = { freeSpace: number; totalSpace?: number | undefined; services: string[]; mounts: string[] };

/**
 * How far apart two reports of one filesystem may be and still be one disk.
 *
 * Measured: SABnzbd's two-decimal gigabytes put the same 4.6 TB filesystem
 * 4.8 MB (0.0001%) from the byte count Radarr gives. This is a thousand times
 * that, and three orders of magnitude below the gap between any two real
 * disks.
 *
 * Relative rather than absolute because the quantisation error scales with the
 * number being reported, and an absolute figure that suited a 10 TB array would
 * be larger than a 240 GB SSD's entire free space.
 */
const SAME_DISK_TOLERANCE = 0.001;

/**
 * Two sizes close enough to be the same filesystem seen twice.
 *
 * Compared against the larger of the pair so the relation is symmetric, with
 * the smaller as the denominator, whether A matched B would depend on which the
 * loop happened to reach first.
 */
function sameSize(a: number, b: number): boolean {
    if (a === b) return true;
    const larger = Math.max(Math.abs(a), Math.abs(b));
    return larger === 0 || Math.abs(a - b) / larger <= SAME_DISK_TOLERANCE;
}

/**
 * Collapse the mounts every service reports down to the disks behind them.
 *
 * Services in a stack are containers over the same host filesystems, so the
 * same two or three disks arrive repeated; ten rows to say "you have two
 * disks", which is a table nobody reads.
 *
 * Free bytes are the fingerprint, compared with a **tolerance rather than for
 * equality**: not every service reports byte precision. SABnzbd returns
 * gigabytes to two decimals, so one 4.6 TB filesystem arrives 4.8 MB away from
 * the exact count Radarr gives for it, and exact equality could never match
 * them; the symptom being the disk listed twice with identical rounded
 * numbers.
 *
 * A mount only joins a group whose total it does not contradict, which guards
 * against a false merge and folds in the torrent clients, which report free
 * space with no total to contradict.
 *
 * A path survives only as part of a group's `mounts`, and only when the
 * caller passes it: which mount is `/storage` is a container-mapping
 * question, so `get_stack_health` strips paths below `detail: "full"`.
 */
export function groupDisks(disks: readonly Mount[]): DiskGroup[] {
    const groups: DiskGroup[] = [];

    for (const disk of disks) {
        const name = disk.label !== undefined && disk.label !== '' ? disk.label : disk.path;
        const mount = name === undefined || name === '' ? disk.service : `${disk.service} ${name}`;
        const group = groups.find(
            g =>
                sameSize(g.freeSpace, disk.freeSpace) &&
                (g.totalSpace === undefined ||
                    disk.totalSpace === undefined ||
                    sameSize(g.totalSpace, disk.totalSpace))
        );

        if (group === undefined) {
            groups.push({
                freeSpace: disk.freeSpace,
                ...(disk.totalSpace === undefined ? {} : { totalSpace: disk.totalSpace }),
                services: [disk.service],
                mounts: [mount]
            });
            continue;
        }

        group.totalSpace ??= disk.totalSpace;
        if (!group.services.includes(disk.service)) group.services.push(disk.service);
        if (!group.mounts.includes(mount)) group.mounts.push(mount);
    }

    // Emptiest first: the disk about to cause a failed import is the one worth
    // reading, and it is never the one with room to spare.
    return groups.sort((a, b) => a.freeSpace - b.freeSpace);
}
