import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'node_modules', 'coverage'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // Unused args are allowed when prefixed with _, which the adapter
            // interfaces rely on for deliberately-unused parameters.
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
        }
    }
);
