import type { ServiceId } from '../config/schema.ts';
import { raw, type SafeHtml } from './html.ts';

/**
 * One drawn mark per service, on a single grid at a single stroke weight.
 *
 * A set drawn as a set is the point: eight marks from eight sources arrive with
 * eight different weights, paddings and palettes, and a card grid is where that
 * shows. Stroke-only in `currentColor` also means one drawing serves both
 * themes instead of a light and a dark variant of each.
 *
 * Strings rather than files for the same reason as `assets.ts`: tsc does not
 * emit non-TypeScript, so a `public/` directory would vanish from the image.
 */

const draw = (paths: string): string =>
    `<svg class="svc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Category first, identity second — the id is already next to the mark, so
 *  the drawing's job is to say "indexer" or "downloader" at a glance. */
export const ICONS: Record<ServiceId, string> = {
    sonarr: draw('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2.5-5 4.5-5-4.5"/>'),
    radarr: draw('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7.5 3v18M16.5 3v18M3 12h18"/>'),
    prowlarr: draw('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="m12 12 6-6"/>'),
    // A bubble rather than a captions screen: the tail is the one thing here
    // that breaks a rectangle's outline, and Sonarr and Jellyfin are already
    // rectangles at the same 20px.
    bazarr: draw(
        '<path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-8.5l-4 4v-4H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5z"/>' +
            '<path d="M6.5 11.5h4M13.5 11.5h4"/>'
    ),
    jellyfin: draw('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8.5 6 3.5-6 3.5z"/>'),
    // Jellyfin is a screen mid-playback; this one is the server behind it — a
    // library you browse (the two lines) over a title you play (the triangle),
    // split by one shelf. Not Plex's arc-and-triangle mark, which this avoids.
    plex: draw(
        '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M4 12h16"/>' +
            '<path d="M8 6.5h8M8 9h5"/><path d="m9 13.5 6 3-6 3z"/>'
    ),
    seerr: draw(
        '<path d="M6.5 6.5h11l3 7v4.5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18v-4.5z"/>' +
            '<path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/><path d="M12 8.5v3M10.5 10h3"/>'
    ),
    sabnzbd: draw(
        // Arc endpoints kept at full precision: rounding them makes the radii
        // unreachable, and the renderer silently scales the curve to compensate.
        '<path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>' +
            '<path d="M12 13v8"/><path d="m8 17 4 4 4-4"/>'
    ),
    transmission: draw(
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'
    ),
    // Transmission already holds the download tray, so this one says the other
    // half of what a torrent client does: the two directions at once.
    qbittorrent: draw(
        '<rect x="3" y="3" width="18" height="18" rx="3"/>' +
            '<path d="M9 7.5v9m0 0-2.5-2.5M9 16.5l2.5-2.5"/><path d="M15 16.5v-9m0 0-2.5 2.5M15 7.5l2.5 2.5"/>'
    )
};

/**
 * The project's own mark: layers gathered into one node.
 *
 * Drawn on the same grid and weight as the eight above, because it sits next to
 * them. The filled node is the only solid shape in the set — it is the "one
 * endpoint" the three layers converge on.
 */
export const LOGO =
    `<svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    '<path d="M13 5.75h8M13 12h8M13 18.25h8"/>' +
    '<path d="M6.7 11.1 12.6 6.1M6.7 12h5.9M6.7 12.9 12.6 17.9"/>' +
    '<circle cx="4.3" cy="12" r="1.85" fill="currentColor" stroke="none"/>' +
    '</svg>';

/**
 * The same mark as a standalone document, for the favicon and the README.
 *
 * Two things have to change at 16px. The converging strokes go, because at that
 * size they are a smudge rather than three lines, and the weight goes up from
 * 1.75 to 2.5. What survives is the silhouette: node, gap, layers.
 *
 * A literal colour rather than `currentColor`, which has nothing to inherit
 * from in a favicon or an `<img>`. This blue holds on both a white README and a
 * near-black one; the config UI's own accent does not, being tuned per theme.
 */
export const MARK_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#4c8dff" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M13.5 6.5h7M13.5 12h7M13.5 17.5h7"/>' +
    '<path d="M8 12h2.5"/>' +
    '<circle cx="5" cy="12" r="2.6" fill="#4c8dff" stroke="none"/>' +
    '</svg>\n';

/** For an id the schema does not know — a service removed from config while its
 *  card is still on screen, or one added before this file catches up. */
const FALLBACK = draw(
    '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v2.5a6 6 0 0 1-12 0z"/><path d="M12 17.5V21"/>'
);

/** Takes an instance id, so `radarr/4k` gets the Radarr mark. */
export function serviceIcon(id: string): SafeHtml {
    const type = id.split('/')[0] ?? '';
    return raw(ICONS[type as ServiceId] ?? FALLBACK);
}
