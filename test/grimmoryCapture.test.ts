import { describe, expect, it } from 'vitest';
import { anonymiseGrimmory } from '../scripts/lib/grimmoryCapture.ts';

describe('anonymiseGrimmory for the write endpoints', () => {
    it('replaces who, where from and what in an audit row', () => {
        const [row] = anonymiseGrimmory([
            {
                id: 7,
                userId: 1,
                username: 'bartus',
                action: 'BOOK_DELETED',
                entityType: 'BOOK',
                entityId: 58,
                description: 'Deleted book: Real Title',
                ipAddress: '10.0.0.4',
                countryCode: 'NL',
                createdAt: '2026-11-07T10:00:00'
            }
        ]) as Record<string, unknown>[];
        expect(row).toMatchObject({
            username: 'example-user',
            ipAddress: '192.0.2.1',
            countryCode: 'ZZ',
            description: 'Example audit entry 7',
            action: 'BOOK_DELETED',
            entityType: 'BOOK',
            entityId: 58,
            createdAt: '2026-11-07T10:00:00'
        });
    });
    it('replaces an external cover or link url and drops reviews and comic or audiobook blocks', () => {
        const [c] = anonymiseGrimmory([
            {
                bookId: 58,
                title: 'Real',
                thumbnailUrl: 'https://covers.example.com/x.jpg',
                externalUrl: 'https://www.goodreads.com/book/show/1',
                bookReviews: [{ reviewerName: 'x' }],
                comicMetadata: {},
                audiobookMetadata: {},
                provider: 'Amazon'
            }
        ]) as Record<string, unknown>[];
        expect(c).toMatchObject({
            thumbnailUrl: 'https://example.invalid/thumbnailUrl/58',
            externalUrl: 'https://example.invalid/externalUrl/58',
            provider: 'Amazon'
        });
        expect(c).not.toHaveProperty('bookReviews');
        expect(c).not.toHaveProperty('comicMetadata');
        expect(c).not.toHaveProperty('audiobookMetadata');
    });
    it('keeps a local cover path', () => {
        expect(anonymiseGrimmory({ id: 58, title: 'x', thumbnailUrl: '/api/books/58/cover' })).toMatchObject({ thumbnailUrl: '/api/books/58/cover' });
    });
});
