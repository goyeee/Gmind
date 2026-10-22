import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**', '**/.zcode/**', 'design-demos/**'] },
  ...tseslint.configs.recommended,
);
