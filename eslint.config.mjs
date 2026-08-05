import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // `src/services/generated` is openapi-typescript output, not source. It is
    // over a megabyte of type declarations that no rule should have an opinion
    // about, and linting it only slows every run down.
    // `tmp-config` is the gitignored scratch directory. It is not source, and
    // linting throwaway probe scripts only produces noise that hides real
    // errors in the output.
    { ignores: ['dist', 'node_modules', 'coverage', 'src/services/generated', 'tmp-config'] },
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
            //
            // `ignoreRestSiblings` covers the omit-by-destructuring idiom the
            // tool projections use — `const { a, ...rest } = x` to drop a field
            // at a lower detail level. Without it every projection needs a
            // disable comment, which is how disable comments start spreading.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
            ]
        }
    }
);
