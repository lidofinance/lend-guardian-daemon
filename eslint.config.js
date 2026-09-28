// @ts-check
// The lint rules are the mechanical half of STYLE_GUIDE.md: what a machine can check is checked
// here, the rest is reviewed. Keep the two in sync.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const STRICT_BOOLEANS = {
  allowString: false,
  allowNumber: false,
  allowNullableObject: true,
  allowNullableBoolean: false,
  allowNullableString: false,
  allowNullableNumber: false,
  allowAny: false,
};

const ONE_IDEA_PER_CONDITION =
  'A condition has at most two operands. Name the parts (const isReady = ...) or extract a predicate.';

/** Statement tests with a nested logical expression: `if (a && b || c)`, `while (a && b && c)`. */
const COMPOUND_CONDITIONS = [
  'IfStatement > LogicalExpression > LogicalExpression',
  'IfStatement > LogicalExpression > UnaryExpression > LogicalExpression',
  'WhileStatement > LogicalExpression > LogicalExpression',
  'DoWhileStatement > LogicalExpression > LogicalExpression',
  'ForStatement > LogicalExpression.test > LogicalExpression',
  'ConditionalExpression > LogicalExpression.test > LogicalExpression',
].map((selector) => ({ selector, message: ONE_IDEA_PER_CONDITION }));

export default defineConfig([
  globalIgnores(['**/node_modules/', 'cache/', '**/dist/', 'eslint.config.js', '**/*.d.ts']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Control flow reads top to bottom: braces always, early returns, no nested ternaries.
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'no-negated-condition': 'error',
      'no-param-reassign': ['error', { props: false }],
      'prefer-const': 'error',
      'prefer-template': 'error',
      'object-shorthand': ['error', 'always'],
      // Prefer meaningful subproblems; document a narrow exception for a coherent larger algorithm.
      'max-depth': ['error', 3],
      'max-params': ['error', 5],
      'max-statements': ['error', 20],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 12],
      'no-restricted-syntax': [
        'error',
        { selector: 'ForInStatement', message: 'Use Object.keys, Object.entries or for...of.' },
        {
          selector: 'ForStatement[test=null]',
          message: 'Use while (true) with explicit state updates and visible exit paths.',
        },
        { selector: 'TSEnumDeclaration', message: 'Use a union of string literals.' },
        ...COMPOUND_CONDITIONS,
      ],
      // Types are explicit at module boundaries and erased safely (type-only imports strip cleanly).
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': ['error', STRICT_BOOLEANS],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: false,
          allowAny: false,
          allowNullish: false,
          allowRegExp: false,
          allowNever: false,
        },
      ],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: 'only-allowed-literals' },
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
  {
    // Keep attempt decisions and observations together; private phases own preparation and waits.
    files: ['src/chain/viem-client.ts'],
    rules: {
      'max-statements': ['error', 60],
      'max-lines-per-function': ['error', { max: 110, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 16],
      'max-depth': ['error', 4],
    },
  },
  {
    // Keep the backward walk, coverage checkpoint and activation evidence checks together.
    files: ['src/contracts/markets.ts'],
    rules: {
      'max-statements': ['error', 50],
      'max-lines-per-function': ['error', { max: 85, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 28],
      'max-depth': ['error', 4],
    },
  },
  {
    // Keep the five cycle phases and their application events visible in execution order.
    files: ['src/core/guardian.ts'],
    rules: {
      'max-statements': ['error', 30],
      'max-lines-per-function': ['error', { max: 85, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Keep the example's Guardian configuration and observe/signal client setup in one factory.
    files: ['example/daemon.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 70, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // A test body is a linear list of assertions and a fixture builder is a literal.
    files: ['tests/**/*.ts'],
    rules: {
      complexity: ['error', 20],
      'max-params': ['error', 7],
      'max-statements': ['error', 40],
      'max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true }],
    },
  },
]);
