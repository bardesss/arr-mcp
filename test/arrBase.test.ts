import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import * as types from '../src/services/types.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';

/**
 * A snapshot of what each *arr adapter can do and of the id refusals the
 * shared base class takes over, so a refactor that drops or adds a capability
 * shows up here.
 */
const cfg: KeyedServiceConfig = {
    url: 'http://127.0.0.1:1',
    api_key: 'k',
    permissions: { safe_write: false, destructive: false }
} as KeyedServiceConfig;

const capabilities = (adapter: unknown): string[] =>
    Object.entries(types)
        .filter(([name, fn]) => /^has[A-Z]/.test(name) && typeof fn === 'function')
        .filter(([, fn]) => (fn as (a: unknown) => boolean)(adapter))
        .map(([name]) => name)
        .sort();

const radarr = [
    'hasBlocklist', 'hasCalendar', 'hasCommandStatus', 'hasDiskSpace', 'hasDownloadTrace', 'hasHealthChecks',
    'hasHistory', 'hasLibrary', 'hasLibraryMaintenance', 'hasLibraryScan', 'hasLogs', 'hasManualImport',
    'hasMediaAdd', 'hasMediaDelete', 'hasMediaDetails', 'hasMediaUpdate', 'hasProfileDiagnostics', 'hasQueue',
    'hasQueueRemove', 'hasReleaseGrab', 'hasReleaseSearch', 'hasScanState', 'hasSearch', 'hasSearchTrigger',
    'hasSeedCriteria', 'hasWanted'
];

describe('*arr adapter capabilities', () => {
    it.each([
        ['radarr', () => new RadarrAdapter(cfg), radarr],
        ['sonarr', () => new SonarrAdapter(cfg), [...radarr, 'hasEpisodeFiles', 'hasEpisodeRemap', 'hasMonitoring'].sort()],
        ['whisparr', () => new WhisparrAdapter(cfg), [
            'hasBlocklist', 'hasCalendar', 'hasDiskSpace', 'hasEpisodeFiles', 'hasHealthChecks', 'hasLibrary',
            'hasLibraryMaintenance', 'hasLibraryScan', 'hasMediaAdd', 'hasMediaDelete', 'hasMediaDetails',
            'hasMonitoring', 'hasProfileDiagnostics', 'hasQueue', 'hasQueueRemove', 'hasReleaseGrab',
            'hasReleaseSearch', 'hasScanState', 'hasSearch', 'hasSearchTrigger', 'hasSeedCriteria'
        ]],
        ['lidarr', () => new LidarrAdapter(cfg), [
            'hasArtistMonitor', 'hasBlocklist', 'hasCalendar', 'hasCommandStatus', 'hasDiskSpace',
            'hasHealthChecks', 'hasHistory', 'hasLibrary', 'hasLibraryMaintenance', 'hasLibraryScan',
            'hasManualImport', 'hasMediaAdd', 'hasMediaDelete', 'hasMediaDetails', 'hasMediaUpdate', 'hasMetadataProfiles',
            'hasMonitorState', 'hasMonitoring', 'hasQueue', 'hasQueueRemove', 'hasReleaseGrab',
            'hasReleaseSearch', 'hasScanState', 'hasSearch', 'hasSearchTrigger', 'hasTagRepair', 'hasWanted'
        ]]
    ])('%s exposes exactly its capabilities', (_name, make, expected) => {
        expect(capabilities(make())).toEqual(expected);
    });
});

describe('*arr id refusals', () => {
    it('Sonarr names a series id', async () => {
        await expect(new SonarrAdapter(cfg).listEpisodeFiles('abc')).rejects.toThrow('"abc" is not a sonarr series id');
    });

    it('Whisparr names a site id', async () => {
        await expect(new WhisparrAdapter(cfg).listEpisodeFiles('abc')).rejects.toThrow('"abc" is not a whisparr site id');
    });

    it('Lidarr names an album id and points at get_media_details', async () => {
        const err = await new LidarrAdapter(cfg).getMonitorState('abc').then(
            () => undefined,
            (e: unknown) => e as { detail: string; remedy?: string }
        );
        expect(err?.detail).toBe('"abc" is not a lidarr album id');
        expect(err?.remedy).toContain('get_media_details');
    });
});
