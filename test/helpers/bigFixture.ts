/**
 * Budget tests need a full-size payload: 500 items at `detail: full`, which is
 * the largest response a tool can legally produce.
 *
 * Copies are deep, so a test mutating one item does not silently alter the
 * others and quietly stop testing what it claims to.
 */
export function repeat<T>(template: T, count: number): T[] {
    return Array.from({ length: count }, () => structuredClone(template));
}
