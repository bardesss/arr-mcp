import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // `src/services/generated` is openapi-typescript output, not source. It is
    // over a megabyte of type declarations that no rule should have an opinion
    // about, and linting it only slows every run down.
    // `tmp-config` is the gitignored scratch directory. It is not source, and
    // linting throwaway probe scripts only produces noise that hides real
    // errors in the output.
    // `.claude` holds git worktrees, each a full checkout with its own
    // tsconfig.json. Without this, having one open fails the whole run with
    // "No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are
    // present" — a lint that breaks depending on what you have checked out
    // elsewhere.
    { ignores: ['dist', 'node_modules', 'coverage', 'src/services/generated', 'tmp-config', '.claude'] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                // Type-aware rules need a program. `projectService` picks the
                // nearest tsconfig per file rather than pinning one.
                // The three root/script config files sit outside tsconfig.json's
                // include and aren't .ts, so they need the default project.
                projectService: {
                    allowDefaultProject: ['eslint.config.mjs', 'vitest.config.ts', 'scripts/codegen.mjs']
                },
                tsconfigRootDir: import.meta.dirname
            }
        }
    },
    {
        // Maintainer scripts run in Node directly rather than through the
        // bundled entrypoint, so they need Node's globals declared.
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            globals: { process: 'readonly', console: 'readonly' }
        }
    },
    {
        // `eslint.config.mjs` and `codegen.mjs` sit outside the main tsconfig
        // program (see `allowDefaultProject` above) and are untyped JS, so the
        // type checker has nothing there to protect — every value it sees is
        // already `any` or unresolved, which is what these rules exist to flag
        // elsewhere.
        files: ['eslint.config.mjs', 'scripts/codegen.mjs'],
        rules: {
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off'
        }
    },
    {
        // `res.json()`/`res.text()` fed straight into `expect(...)`, `@ts-expect-error`
        // blocks that exist to prove a type error at compile time, casts on mock
        // fixtures, and one documented `new Function` syntax check — none of it is a
        // real defect. `no-floating-promises` and `no-misused-promises` stay on here.
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unnecessary-type-assertion': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-implied-eval': 'off'
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
            ],
            // Every finding here is a function that must match a shared async
            // signature — `plan()` on write tools, vitest's `it(..., async () => {})`,
            // the integration script's `check()` callback — without needing to await
            // inside. None of them are missing an await; the shape is the contract.
            '@typescript-eslint/require-await': 'off',
            // Every finding here is a deliberate `String(unknown)` coercion of data
            // this project does not control: `esc()`'s universal escape, a non-string
            // upstream health `type`, a YAML map key, an id from a generated spec
            // union. The alternative is runtime validation of data that was never
            // going to be more than "probably a string".
            '@typescript-eslint/no-base-to-string': 'off'
        }
    }
);
