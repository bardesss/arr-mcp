import { describe, expect, it } from 'vitest';
import { anonymiseActivityLog, anonymiseLogUser, EmbyScrubber } from '../scripts/lib/embyCapture.ts';

const A = 'aaaa0000000000000000000000000001';
const B = 'bbbb0000000000000000000000000002';
const C = 'cccc0000000000000000000000000003';
const fake = (n: number): string => String(n).padStart(32, '0');

describe('EmbyScrubber', () => {
    it('gives each server id one placeholder across fixtures, in the order first seen', () => {
        const s = new EmbyScrubber();
        expect(s.scrub({ Id: A })).toEqual({ Id: fake(1) });
        const users = s.scrub([{ ServerId: A, Id: B }]);
        expect(users).toEqual([{ ServerId: fake(1), Id: fake(2) }]);
        // Only the id inside a longer value changes.
        expect(s.scrub(`p-tmdb-Movie-42-${C}`)).toBe(`p-tmdb-Movie-42-${fake(3)}`);
        // A placeholder is left alone on a second pass.
        expect(s.scrub(users)).toEqual(users);
    });

    it('moves capture times to 2024-01-02 keeping their gaps, and leaves a film or series date alone', () => {
        const s = new EmbyScrubber();
        expect(s.scrub(['2024-01-05T10:00:00.0000000Z', '2024-01-05T09:59:50.0000000Z', '2024-01-06T10:00:00.0000000Z', '1945-11-30T00:00:00.0000000Z'])).toEqual([
            '2024-01-02T12:00:00.000Z',
            '2024-01-02T11:59:50.000Z',
            '2024-01-03T12:00:00.000Z',
            '1945-11-30T00:00:00.0000000Z'
        ]);
    });

    it('drops what nothing reads, the MAC address among it', () => {
        const s = new EmbyScrubber();
        expect(
            s.scrub({
                Name: 'Example Film',
                WakeOnLanInfo: [{ MacAddress: 'Fixture text', Port: 9 }],
                ImageTags: { Primary: 'Fixture text' },
                SeriesPrimaryImageTag: 'Fixture text',
                PrimaryImageAspectRatio: 2,
                Chapters: [{ Name: 'Fixture name' }],
                Overview: 'Fixture text'
            })
        ).toEqual({ Name: 'Example Film' });
    });

    it('replaces a renamed name, and the server name, wherever a later fixture writes it as a word', () => {
        const s = new EmbyScrubber();
        expect(s.scrub({ ServerName: 'host-1' })).toEqual({ ServerName: 'Server 1' });
        s.rename('someone', 'User 2');
        expect(s.scrub('someone is playing Example Film on host-1')).toBe('User 2 is playing Example Film on Server 1');
        expect(s.scrub('someones, nosomeone, host-12')).toBe('someones, nosomeone, host-12');
    });

    it('replaces a longer name before a shorter one it starts with, whatever the order they came in', () => {
        const s = new EmbyScrubber();
        s.rename('someone', 'User 1');
        s.rename('someone else', 'User 2');
        expect(s.scrub('someone else is playing Example Film')).toBe('User 2 is playing Example Film');
        expect(s.scrub('someone is playing Example Film')).toBe('User 1 is playing Example Film');
    });

    it('moves the folders above the library folder to /media/, as the *arr captures name them', () => {
        const s = new EmbyScrubber();
        expect(s.scrub('/share/lib/movies/Item 1/File 1.bin')).toBe('/media/movies/Item 1/File 1.bin');
        expect(s.scrub('/media/tv/Item 1/File 1.bin')).toBe('/media/tv/Item 1/File 1.bin');
        expect(s.scrub('/share/lib/music')).toBe('/media/music');
        expect(s.scrub('/share/lib/Item 1/File 1.bin')).toBe('/share/lib/Item 1/File 1.bin');
    });
});

describe('the activity log and its user', () => {
    it('keeps a playback sentence only when it opens with a user placeholder', () => {
        const page = {
            Items: [
                { Type: 'playback.stop', Name: 'User 2 has finished playing Example Film on Device 1' },
                // A user /Users did not list, so the scrub never renamed them.
                { Type: 'playback.start', Name: 'someone is playing Example Film on Device 1' },
                { Type: 'user.authenticated', Name: 'User 2 signed in' }
            ],
            TotalRecordCount: 3
        };
        expect(anonymiseActivityLog(page)).toEqual({
            Items: [
                { Type: 'playback.stop', Name: 'User 2 has finished playing Example Film on Device 1' },
                { Type: 'playback.start', Name: 'Fixture message 2' },
                { Type: 'user.authenticated', Name: 'Fixture message 3' }
            ],
            TotalRecordCount: 3
        });
    });

    it('gives the log user a placeholder the scrub did not', () => {
        expect(anonymiseLogUser({ Name: 'User 1', Prefix: 'S' })).toEqual({ Name: 'User 1', Prefix: 'U' });
        expect(anonymiseLogUser({ Name: 'someone', Prefix: 'S' })).toEqual({ Name: 'User 2', Prefix: 'U' });
    });
});
