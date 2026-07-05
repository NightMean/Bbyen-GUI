// ESLint flat config (ESLint 9+). Replaces the old .eslintrc.js.
// This is a faithful migration of the previous ruleset: eslint:recommended
// plus the project's style rules. The TypeScript parser is added so .ts files
// are parsed (the old config silently failed to lint them), but the opinionated
// typescript-eslint rule sets are intentionally NOT enabled here to avoid
// changing the established linting policy.
const js = require('@eslint/js')
const tsParser = require('@typescript-eslint/parser')

module.exports = [
	js.configs.recommended,
	{
		files: [ '**/*.ts' ],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2021,
			sourceType: 'module',
		},
		rules: {
			// TypeScript syntax confuses the core no-unused-vars / no-undef
			// rules (types read as undefined globals); the compiler already
			// covers these for .ts files.
			'no-unused-vars': 'off',
			'no-undef': 'off',
			'indent': [ 'error', 'tab' ],
			'linebreak-style': [ 'error', 'unix' ],
			'quotes': [ 'error', 'single' ],
			'semi': [ 'error', 'never' ],
			'max-len': [
				'error',
				{ 'code': 80, 'tabWidth': 2, 'ignoreUrls': true },
			],
		},
	},
	{
		ignores: [ 'eslint.config.js', 'node_modules/**', '**/*.d.ts' ],
	},
]
