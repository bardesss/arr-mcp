/**
 * Lidarr metadata profile facts that `add_media` and `update_media` both put
 * into a preview, worded once.
 */

/**
 * Lidarr's reserved metadata profile, which every install has
 * (`MetadataProfileService.NONE_PROFILE_NAME`, created at startup; no other
 * profile may take the name). Its album type lists are empty, so Lidarr lists
 * no albums for an artist on it (`SkyHookProxy.FilterAlbums`), and a refresh
 * then removes every album the artist had that has no files and was not added
 * by hand (`RefreshAlbumService.ShouldDelete`).
 */
export const NO_ALBUMS_PROFILE = 'None';

/**
 * A refresh of a monitored artist searches the monitored albums it added that
 * are already released: all of them up to 3.2.0.5144 (`AlbumAddedService`),
 * and in later versions just those released in the last 180 days
 * (`AlbumRefreshedService`), where the older ones wait for RSS sync or a search
 * started by hand. The search runs at the artist's next scan
 * (`ArtistScannedHandler`), from album ids held in memory: the rescan after the
 * refresh, or, when the "Rescan Artist Folder after Refresh" setting skips that
 * (Never, or After Manual Refresh for a scheduled refresh;
 * `RefreshArtistService.RescanArtists`, default Always), the next disk scan.
 */
export const SEARCH_AFTER_REFRESH =
    "Lidarr then searches the released ones while the artist is monitored, at the rescan after that refresh, or at its next disk scan when Lidarr's 'Rescan Artist Folder after Refresh' setting skips that rescan (in Lidarr newer than 3.2.0.5144, only those released in the last 180 days; older ones wait for RSS sync or trigger_search).";
