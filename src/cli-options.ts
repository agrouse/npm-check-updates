import _ from 'lodash'
import Table from 'cli-table'
import chalk from 'chalk'
import { deepPatternPrefix } from './constants'
import { Index } from './types/IndexType'

export interface CLIOption<T = any> {
  arg?: string
  default?: T
  deprecated?: boolean
  description: string
  help?: string
  parse?: (s: string, p?: T) => T
  long: string
  short?: string
  type: string
}

/**
 * "newest" means most recently released in terms of release date, even if there are other version numbers that are higher. It includes prereleases.
 * "greatest" means the highest version number, regardless of release date. It includes prereleases.
 * "latest" is whatever the project's "latest" git tag points to. It's usually the non-prerelease version with the highest version number, but is ultimately decided by each project's maintainers.
 * "minor" means the highest minor version without incrementing the current major.
 * "patch" means the highest patch version without incrementing the current major or minor.
 **/
const getHelpTargetTable = (): string => {
  /* eslint-disable fp/no-mutating-methods */

  const table = new Table({
    colAligns: ['right', 'left'],
  })

  table.push([
    'greatest',
    `Upgrade to the highest version number published, regardless of release date or tag.
Includes prereleases.`,
  ])
  table.push(['latest', `Upgrade to whatever the package's "latest" git tag points to. Excludes pre is specified.`])
  table.push(['minor', 'Upgrade to the highest minor version without bumping the major version.'])
  table.push([
    'newest',
    `Upgrade to the version with the most recent publish date, even if there are
other version numbers that are higher. Includes prereleases.`,
  ])
  table.push(['patch', `Upgrade to the highest patch version without bumping the minor or major versions.`])
  table.push(['@[tag]', `Upgrade to the version published to a specific tag, e.g. 'next' or 'beta'.`])

  return `Determines the version to upgrade to. (default: "latest")

${table.toString()}

You can also specify a custom function in your .ncurc.js file, or when importing npm-check-updates:

  ${chalk.gray(`/** Custom target.
    @param dependencyName The name of the dependency.
    @param parsedVersion A parsed Semver object from semver-utils.
      (See https://git.coolaj86.com/coolaj86/semver-utils.js#semverutils-parse-semverstring)
    @returns One of the valid target values (specified in the table above).
  */`)}
  ${chalk.cyan(
    'target',
  )}: (dependencyName, [{ semver, version, operator, major, minor, patch, release, build }]) ${chalk.cyan('=>')} {
    ${chalk.red('if')} (major ${chalk.red('===')} ${chalk.blue('0')}) ${chalk.red('return')} ${chalk.yellow("'minor'")}
    ${chalk.red('return')} ${chalk.yellow("'latest'")}
  }

`
}

// store CLI options separately from bin file so that they can be used to build type definitions
const cliOptions: CLIOption[] = [
  {
    long: 'color',
    description: 'Force color in terminal',
    type: 'boolean',
  },
  {
    long: 'concurrency',
    arg: 'n',
    description: 'Max number of concurrent HTTP requests to registry.',
    parse: s => parseInt(s, 10),
    default: 8,
    type: 'number',
  },
  {
    long: 'configFileName',
    arg: 'filename',
    description: 'Config file name. (default: .ncurc.{json,yml,js})',
    type: 'string',
  },
  {
    long: 'configFilePath',
    arg: 'path',
    description: 'Directory of .ncurc config file. (default: directory of `packageFile`)',
    type: 'string',
  },
  {
    long: 'cwd',
    arg: 'path',
    description: 'Working directory in which npm will be executed.',
    type: 'string',
  },
  {
    long: 'deep',
    description: `Run recursively in current working directory. Alias of (--packageFile '${deepPatternPrefix}package.json').`,
    type: 'boolean',
  },
  {
    long: 'dep',
    arg: 'value',
    description:
      'Check one or more sections of dependencies only: dev, optional, peer, prod, bundle (comma-delimited).',
    default: 'prod,dev,bundle,optional',
    type: 'string',
  },
  {
    long: 'deprecated',
    description: 'Include deprecated packages.',
    type: 'boolean',
  },
  {
    long: 'doctor',
    description:
      'Iteratively installs upgrades and runs tests to identify breaking upgrades. Run "ncu --doctor" for detailed help. Add "-u" to execute.',
    type: 'boolean',
  },
  {
    long: 'doctorInstall',
    arg: 'command',
    description: 'Specifies the install script to use in doctor mode. (default: npm install/yarn)',
    type: 'string',
  },
  {
    long: 'doctorTest',
    arg: 'command',
    description: 'Specifies the test script to use in doctor mode. (default: npm test)',
    type: 'string',
  },
  {
    long: 'enginesNode',
    description: 'Include only packages that satisfy engines.node as specified in the package file.',
    type: 'boolean',
  },
  {
    long: 'errorLevel',
    short: 'e',
    arg: 'n',
    description:
      'Set the error level. 1: exits with error code 0 if no errors occur. 2: exits with error code 0 if no packages need updating (useful for continuous integration).',
    parse: s => parseInt(s, 10),
    default: 1,
    type: 'number',
  },
  {
    long: 'filter',
    short: 'f',
    arg: 'matches',
    description:
      'Include only package names matching the given string, wildcard, glob, comma-or-space-delimited list, /regex/, or predicate function.',
    type: 'string | string[] | RegExp | RegExp[] | FilterFunction',
  },
  {
    long: 'filterVersion',
    arg: 'matches',
    description: 'Filter on package version using comma-or-space-delimited list, /regex/, or predicate function.',
    type: 'string | string[] | RegExp | RegExp[] | FilterFunction',
  },
  {
    long: 'format',
    arg: 'value',
    description:
      'Enable additional output data, string or comma-delimited list: ownerChanged, repo. ownerChanged: shows if the package owner changed between versions. repo: infers and displays links to source code repository.',
    parse: value => (typeof value === 'string' ? value.split(',') : value),
    default: [],
    type: 'string[]',
  },
  {
    long: 'global',
    short: 'g',
    description: 'Check global packages instead of in the current project.',
    type: 'boolean',
  },
  {
    long: 'interactive',
    short: 'i',
    description: 'Enable interactive prompts for each dependency; implies -u unless one of the json options are set.',
    type: 'boolean',
  },
  {
    // program.json is set to true in programInit if any options that begin with 'json' are true
    long: 'jsonAll',
    short: 'j',
    description: 'Output new package file instead of human-readable message.',
    type: 'boolean',
  },
  {
    long: 'jsonDeps',
    description:
      'Like `jsonAll` but only lists `dependencies`, `devDependencies`, `optionalDependencies`, etc of the new package data.',
    type: 'boolean',
  },
  {
    long: 'jsonUpgraded',
    description: 'Output upgraded dependencies in json.',
    type: 'boolean',
  },
  {
    long: 'loglevel',
    short: 'l',
    arg: 'n',
    description: 'Amount to log: silent, error, minimal, warn, info, verbose, silly.',
    default: 'warn',
    type: 'string',
  },
  {
    long: 'mergeConfig',
    description: `Merges nested configs with the root config file for --deep or --packageFile options. (default: false)`,
    type: 'boolean',
  },
  {
    long: 'minimal',
    short: 'm',
    description: 'Do not upgrade newer versions that are already satisfied by the version range according to semver.',
    type: 'boolean',
  },
  {
    long: 'packageData',
    arg: 'value',
    description: 'Package file data (you can also use stdin).',
    type: 'string | PackageFile',
  },
  {
    long: 'packageFile',
    arg: 'path|glob',
    description: 'Package file(s) location. (default: ./package.json)',
    type: 'string',
  },
  {
    long: 'packageManager',
    short: 'p',
    arg: 'name',
    // manual default to allow overriding auto yarn detection
    description: 'npm, yarn (default: "npm")',
    type: 'string',
  },
  {
    long: 'peer',
    description:
      'Check peer dependencies of installed packages and filter updates to compatible versions. Run "ncu --help --peer" for details.',
    type: 'boolean',
    help: `Check peer dependencies of installed packages and filter updates to compatible versions.

${chalk.bold('Example')}

The following example demonstrates how --peer works, and how it uses peer dependencies from upgraded modules.

The package ${chalk.bold('ncu-test-peer-update')} has two versions published:

- 1.0.0 has peer dependency "ncu-test-return-version": "1.0.x"
- 1.1.0 has peer dependency "ncu-test-return-version": "1.1.x"

Our test app has the following dependencies:

    "ncu-test-peer-update": "1.0.0",
    "ncu-test-return-version": "1.0.0"

The latest versions of these packages are:

    "ncu-test-peer-update": "1.1.0",
    "ncu-test-return-version": "2.0.0"

${chalk.bold('With --peer')}

ncu upgrades packages to the highest version that still adheres to the peer dependency constraints:


 ncu-test-peer-update     1.0.0  →  1.${chalk.cyan('1.0')}
 ncu-test-return-version  1.0.0  →  1.${chalk.cyan('1.0')}

${chalk.bold('Without --peer')}

As a comparison: without using the --peer option, ncu will suggest the latest versions, ignoring peer dependencies:

 ncu-test-peer-update     1.0.0  →  1.${chalk.cyan('1.0')}
 ncu-test-return-version  1.0.0  →  ${chalk.red('2.0.0')}
  `,
  },
  {
    long: 'pre',
    arg: 'n',
    description: 'Include -alpha, -beta, -rc. (default: 0; default with --newest and --greatest: 1)',
    parse: s => !!parseInt(s, 10),
    type: 'number',
  },
  {
    long: 'prefix',
    arg: 'path',
    description: 'Current working directory of npm.',
    type: 'string',
  },
  {
    long: 'registry',
    short: 'r',
    arg: 'url',
    description: 'Third-party npm registry.',
    type: 'string',
  },
  {
    long: 'reject',
    short: 'x',
    arg: 'matches',
    description:
      'Exclude packages matching the given string, wildcard, glob, comma-or-space-delimited list, /regex/, or predicate function.',
    parse: (s, p) => p.concat([s]),
    default: [],
    type: 'string | string[] | RegExp | RegExp[] | FilterFunction',
  },
  {
    long: 'rejectVersion',
    arg: 'matches',
    description: 'Exclude package.json versions using comma-or-space-delimited list, /regex/, or predicate function.',
    type: 'string | string[] | RegExp | RegExp[] | FilterFunction',
  },
  {
    long: 'removeRange',
    description: 'Remove version ranges from the final package version.',
    type: 'boolean',
  },
  {
    long: 'retry',
    arg: 'n',
    description: 'Number of times to retry failed requests for package info.',
    parse: s => parseInt(s, 10),
    default: 3,
    type: 'number',
  },
  {
    long: 'silent',
    short: 's',
    description: "Don't output anything (--loglevel silent).",
    type: 'boolean',
  },
  {
    long: 'stdin',
    description: 'Read package.json from stdin.',
    type: 'string',
  },
  {
    long: 'target',
    short: 't',
    arg: 'value',
    description:
      'Determines the version to upgrade to: latest, newest, greatest, minor, patch, @[tag], or [function]. Run "ncu --help --target" for details. (default: "latest")',
    help: getHelpTargetTable(),
    // eslint-disable-next-line no-template-curly-in-string
    type: `'latest' | 'newest' | 'greatest' | 'minor' | 'patch' | ${'`@${string}`'} | TargetFunction`,
  },
  {
    long: 'timeout',
    arg: 'ms',
    description: 'Global timeout in milliseconds. (default: no global timeout and 30 seconds per npm-registry-fetch)',
    type: 'number',
  },
  {
    long: 'upgrade',
    short: 'u',
    description: 'Overwrite package file with upgraded versions instead of just outputting to console.',
    type: 'boolean',
  },
]

// put cliOptions into an object for O(1) lookups
export const cliOptionsMap = cliOptions.reduce(
  (accum, option) => ({
    ...accum,
    ...(option.short ? { [option.short]: option } : null),
    ...(option.long ? { [option.long]: option } : null),
  }),
  {} as Index<CLIOption>,
)

const cliOptionsSorted = _.sortBy(cliOptions, 'long')

export default cliOptionsSorted
