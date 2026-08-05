import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // `src/services/generated` is openapi-typescript output, not source. It is
    // over a megabyte of type declarations that no rule should have an opinion
    // about, and linting it only slows every run down.
    { ignores: ['dist', 'node_modules', 'coverage', 'src/services/generated'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // Maintainer scripts run in Node directly rather than through the
        // bundled entrypoint, so they need Node's globals declared.
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            globals: { process: 'readonly', console: 'readonly' }
        }
    },
    {
        rules: {
            // Unused args are allowed when prefixed with _, which the adapter
            // interfaces rely on for deliberately-unused parameters.
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
        }
    }
);
