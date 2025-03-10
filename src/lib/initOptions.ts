import _ from 'lodash'
import fs from 'fs'
import Chalk from 'chalk'
import cliOptions from '../cli-options'
import { deepPatternPrefix } from '../constants'
import programError from './programError'
import getPackageFileName from './getPackageFileName'
import { print } from '../logging'
import { Options } from '../types/Options'
import { RunOptions } from '../types/RunOptions'
import { Target } from '../types/Target'

/** Initializes, validates, sets defaults, and consolidates program options. */
function initOptions(runOptions: RunOptions, { cli }: { cli?: boolean } = {}): Options {
  const chalk = runOptions.color ? new Chalk.Instance({ level: 1 }) : Chalk

  // if not executed on the command-line (i.e. executed as a node module), set the defaults
  if (!cli) {
    // set cli defaults since they are not set by commander in this case
    const cliDefaults = cliOptions.reduce(
      (acc, curr) => ({
        ...acc,
        ...(curr.default != null ? { [curr.long]: curr.default } : null),
      }),
      {},
    )

    // set default options that are specific to module usage
    const moduleDefaults: Options = {
      jsonUpgraded: true,
      silent: runOptions.silent || runOptions.loglevel === undefined,
      args: [],
    }

    runOptions = { ...cliDefaults, ...moduleDefaults, ...runOptions }
  }

  // convert packageData to string to convert RunOptions to Options
  const options = {
    ...runOptions,
    ...(runOptions.packageData && typeof runOptions.packageData !== 'string'
      ? { packageData: JSON.stringify(runOptions.packageData, null, 2) }
      : null),
  } as Options

  const loglevel = options.silent ? 'silent' : options.loglevel

  const json = Object.keys(options)
    .filter(option => option.startsWith('json'))
    .some(_.propertyOf(options))

  if (!json && loglevel !== 'silent' && options.rcConfigPath && !options.doctor) {
    print(options, `Using config file ${options.rcConfigPath}`)
  }

  // warn about deprecated options
  const deprecatedOptions = cliOptions.filter(({ long, deprecated }) => deprecated && options[long as keyof Options])
  if (deprecatedOptions.length > 0) {
    deprecatedOptions.forEach(({ long, description }) => {
      const deprecationMessage = `--${long}: ${description}`
      print(options, chalk.yellow(deprecationMessage), 'warn')
    })
    print(options, '', 'warn')
  }

  // disallow non-matching filter and args
  if (options.filter && (options.args || []).length > 0 && options.filter !== options.args!.join(' ')) {
    programError(
      options,
      chalk.red('Cannot specify a filter using both --filter and args. Did you forget to quote an argument?') +
        '\nSee: https://github.com/raineorshine/npm-check-updates/issues/759#issuecomment-723587297',
    )
  } else if (options.packageFile && options.deep) {
    programError(
      options,
      chalk.red(
        `Cannot specify both --packageFile and --deep. --deep is an alias for --packageFile '${deepPatternPrefix}package.json'`,
      ),
    )
  }

  const target: Target = options.target || 'latest'

  const autoPre = target === 'newest' || target === 'greatest'

  const format = options.format || []

  // autodetect yarn
  const files = fs.readdirSync(options.cwd || '.')
  const autoYarn =
    !options.packageManager && !options.global && files.includes('yarn.lock') && !files.includes('package-lock.json')
  if (autoYarn) {
    print(options, 'Using yarn')
  }

  return {
    ...options,
    ...(options.deep ? { packageFile: `${deepPatternPrefix}${getPackageFileName(options)}` } : null),
    ...((options.args || []).length > 0 ? { filter: options.args!.join(' ') } : null),
    ...(format.length > 0 ? { format } : null),
    cli,
    // add shortcut for any keys that start with 'json'
    json,
    // convert silent option to loglevel silent
    loglevel,
    minimal: options.minimal === undefined ? false : options.minimal,
    // default to false, except when newest or greatest are set
    ...(options.pre != null || autoPre ? { pre: options.pre != null ? !!options.pre : autoPre } : null),
    target,
    // imply upgrade in interactive mode when json is not specified as the output
    ...(options.interactive && options.upgrade === undefined ? { upgrade: !json } : null),
    ...(!options.packageManager && { packageManager: autoYarn ? 'yarn' : 'npm' }),
  }
}

export default initOptions
