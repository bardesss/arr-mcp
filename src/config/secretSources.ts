import { readFileSync } from 'node:fs';
import { instanceId } from './instances.ts';
import type { Config, ServiceId } from './schema.ts';

/**
 * Service credentials kept out of config.yaml (#636).
 *
 * Two forms, both written in the file in place of the secret itself:
 *
 * - `api_key_file: /run/secrets/radarr_api_key` (or `password_file`) reads the
 *   file, the shape Docker, Podman and systemd secrets all take. One trailing
 *   newline is dropped, since `echo key > file` and most editors add one.
 * - `api_key: ${RADARR_API_KEY}` reads that environment variable. Only a value
 *   that is exactly `${NAME}`: there is no interpolation inside a longer
 *   string, so a key that happens to contain `${` elsewhere is still itself.
 *
 * The parsed config keeps the reference and nothing else holds the resolved
 * value for long: `buildAdapters` resolves its own copy each time it builds,
 * so the config UI, the management API and `saveConfig` only ever see the
 * reference and write the reference back.
 */

const SECRET_FIELDS = ['api_key', 'password'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export type SecretSource = { kind: 'file'; path: string } | { kind: 'env'; name: string };

const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export const isEnvReference = (value: string): boolean => ENV_REFERENCE.test(value);

/** Where an entry's credential comes from, or undefined when it is written inline (or absent). */
export function secretSource(entry: Readonly<Record<string, unknown>>, field: SecretField): SecretSource | undefined {
    const file = entry[`${field}_file`];
    if (typeof file === 'string') return { kind: 'file', path: file };
    const value = entry[field];
    const name = typeof value === 'string' ? ENV_REFERENCE.exec(value)?.[1] : undefined;
    return name === undefined ? undefined : { kind: 'env', name };
}

/** How the config UI and the API name a source to the person editing. */
export const describeSource = (source: SecretSource, field: SecretField): string =>
    source.kind === 'file'
        ? `set from the file named in ${field}_file`
        : `set from the environment variable ${source.name}`;

/**
 * One or more references that did not resolve. Each problem names the instance
 * and the field, and never the value: this text reaches the unauthenticated
 * repair page.
 */
export class SecretSourceError extends Error {
    readonly problems: readonly string[];

    constructor(problems: readonly string[]) {
        super(problems.join('\n'));
        this.name = 'SecretSourceError';
        this.problems = problems;
    }
}

type SecretReaders = {
    env?: Readonly<Record<string, string | undefined>>;
    readFile?: (path: string) => string;
};

const stripOneNewline = (text: string): string => text.replace(/\r?\n$/, '');

function resolveEntry(
    type: ServiceId,
    entry: Record<string, unknown>,
    readers: Required<SecretReaders>,
    problems: string[]
): Record<string, unknown> {
    let out = entry;
    for (const field of SECRET_FIELDS) {
        const source = secretSource(entry, field);
        if (source === undefined) continue;
        const where = `services.${instanceId(type, entry.name as string | undefined)}`;
        let value: string | undefined;
        if (source.kind === 'file') {
            try {
                value = stripOneNewline(readers.readFile(source.path));
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
                problems.push(`${where}.${field}_file: the file could not be read (${code})`);
                continue;
            }
            if (value === '') problems.push(`${where}.${field}_file: the file is empty`);
        } else {
            value = readers.env[source.name];
            if (value === undefined) problems.push(`${where}.${field}: environment variable ${source.name} is not set`);
            else if (value === '') problems.push(`${where}.${field}: environment variable ${source.name} is empty`);
        }
        if (value === undefined || value === '') continue;
        const { [`${field}_file`]: _file, ...rest } = out;
        out = { ...rest, [field]: value };
    }
    return out;
}

/**
 * The config with every credential reference replaced by its value, or a
 * `SecretSourceError` naming each one that did not resolve.
 */
export function resolveSecrets(config: Config, readers: SecretReaders = {}): Config {
    const read: Required<SecretReaders> = {
        env: readers.env ?? process.env,
        readFile: readers.readFile ?? (path => readFileSync(path, 'utf8'))
    };
    const problems: string[] = [];
    const services: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config.services)) {
        if (value === undefined) continue;
        const type = key as ServiceId;
        services[key] = Array.isArray(value)
            ? value.map(entry => resolveEntry(type, entry as Record<string, unknown>, read, problems))
            : resolveEntry(type, value, read, problems);
    }
    if (problems.length > 0) throw new SecretSourceError(problems);
    return { ...config, services: services };
}
