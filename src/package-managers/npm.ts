'use strict'

import _ from 'lodash'
import cint from 'cint'
import fs from 'fs'
import semver from 'semver'
import spawn from 'spawn-please'
import pacote from 'pacote'
import memoize from 'fast-memoize'
import libnpmconfig from '../lib/libnpmconfig'
import * as versionUtil from '../version-util'
import { print } from '../logging'
import { GetVersion } from '../types/GetVersion'
import { Index } from '../types/IndexType'
import { Options } from '../types/Options'
import { NpmOptions } from '../types/NpmOptions'
import { Packument } from '../types/Packument'
import { Version } from '../types/Version'
import { VersionSpec } from '../types/VersionSpec'
import {
  allowDeprecatedOrIsNotDeprecated,
  allowPreOrIsNotPre,
  satisfiesNodeEngine,
  satisfiesPeerDependencies,
} from './filters'

const TIME_FIELDS = ['modified', 'created']

/** Reads the local npm config and normalizes keys for pacote. */
const readNpmConfig = () => {
  const npmConfigToPacoteMap = {
    cafile: (path: string) => {
      // load-cafile, based on github.com/npm/cli/blob/40c1b0f/lib/config/load-cafile.js
      if (!path) return
      const cadata = fs.readFileSync(path, 'utf8')
      const delim = '-----END CERTIFICATE-----'
      const output = cadata
        .split(delim)
        .filter(xs => !!xs.trim())
        .map(xs => `${xs.trimStart()}${delim}`)
      return { ca: output }
    },
    maxsockets: 'maxSockets',
    'strict-ssl': 'strictSSL',
  }

  // config variables that need to be converted from strings to boolean values
  // store in lowercase since they are strictly for comparison purposes
  const booleanKeys = { strictssl: true }

  /** Parses a string to a boolean. */
  const stringToBoolean = (s: string) => !!s && s !== 'false' && s !== '0'

  // needed until pacote supports full npm config compatibility
  // See: https://github.com/zkat/pacote/issues/156
  const config: Index<string | boolean> = {}
  // libnpmconfig incorrectly (?) ignores NPM_CONFIG_USERCONFIG because it is always overridden by the default builtin.userconfig
  // set userconfig manually so that it is prioritized
  const builtinsWithUserConfig = {
    userconfig: process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG,
  }
  libnpmconfig.read(null, builtinsWithUserConfig).forEach((value: string, key: string) => {
    // replace env ${VARS} in strings with the process.env value
    const normalizedValue =
      typeof value !== 'string'
        ? value
        : // parse stringified booleans
        key.replace(/-/g, '').toLowerCase() in booleanKeys
        ? stringToBoolean(value)
        : value.replace(/\${([^}]+)}/, (_, envVar) => process.env[envVar] as string)

    const { [key]: pacoteKey }: Index<string | ((path: string) => any)> = npmConfigToPacoteMap
    if (_.isString(pacoteKey)) {
      config[pacoteKey] = normalizedValue
    } else if (_.isFunction(pacoteKey)) {
      _.assign(config, pacoteKey(normalizedValue))
    } else {
      config[key.match(/^[a-z]/i) ? _.camelCase(key) : key] = normalizedValue
    }
  })

  config.cache = false

  return config
}

const npmConfig = readNpmConfig()

/**
 * @typedef {object} CommandAndPackageName
 * @property {string} command
 * @property {string} packageName
 */

/**
 * Parse JSON and throw an informative error on failure.
 *
 * @param result Data to be parsed
 * @param data
 * @returns
 */
function parseJson(result: string, data: { command?: string; packageName?: string }) {
  let json
  // use a try-catch instead of .catch to avoid re-catching upstream errors
  try {
    json = JSON.parse(result)
  } catch (err) {
    throw new Error(
      `Expected JSON from "${data.command}". This could be due to npm instability${
        data.packageName ? ` or problems with the ${data.packageName} package` : ''
      }.\n\n${result}`,
    )
  }
  return json
}

/**
 * Check if package author changed between current and upgraded version.
 *
 * @param packageName Name of the package
 * @param currentVersion Current version declaration (may be range)
 * @param upgradedVersion Upgraded version declaration (may be range)
 * @param npmConfigLocal Additional npm config variables that are merged into the system npm config
 * @returns A promise that fullfills with boolean value.
 */
export async function packageAuthorChanged(
  packageName: string,
  currentVersion: VersionSpec,
  upgradedVersion: VersionSpec,
  options: Options = {},
  npmConfigLocal?: Index<string | boolean>,
) {
  const result = await pacote.packument(packageName, {
    ...npmConfigLocal,
    ...npmConfig,
    fullMetadata: true,
    ...(options.registry ? { registry: options.registry, silent: true } : null),
  })
  if (result.versions) {
    const pkgVersions = Object.keys(result.versions)
    const current = semver.minSatisfying(pkgVersions, currentVersion)
    const upgraded = semver.maxSatisfying(pkgVersions, upgradedVersion)
    if (current && upgraded && result.versions[current]._npmUser && result.versions[upgraded]._npmUser) {
      const currentAuthor = result.versions[current]._npmUser?.name
      const latestAuthor = result.versions[upgraded]._npmUser?.name
      return !_.isEqual(currentAuthor, latestAuthor)
    }
  }

  return false
}

interface ViewOptions {
  registry?: string
  timeout?: number
  retry?: number
}

/**
 * Returns an object of specified values retrieved by npm view.
 *
 * @param packageName   Name of the package
 * @param fields        Array of fields like versions, time, version
 * @param               currentVersion
 * @returns             Promised result
 */
export async function viewMany(
  packageName: string,
  fields: string[],
  currentVersion: Version,
  { registry, timeout, retry }: ViewOptions = {},
  retried = 0,
  npmConfigLocal?: Index<string | boolean>,
) {
  if (currentVersion && (!semver.validRange(currentVersion) || versionUtil.isWildCard(currentVersion))) {
    return Promise.resolve({} as Packument)
  }

  let result: any
  try {
    result = await pacote.packument(packageName, {
      ...npmConfigLocal,
      ...npmConfig,
      fullMetadata: fields.includes('time'),
      ...(registry ? { registry, silent: true } : null),
      timeout,
    })
  } catch (err: any) {
    if (retry && ++retried <= retry) {
      const packument: Packument = await viewMany(
        packageName,
        fields,
        currentVersion,
        { registry, timeout, retry },
        retried,
        npmConfigLocal,
      )
      return packument
    }

    throw err
  }
  return fields.reduce(
    (accum, field) => ({
      ...accum,
      [field]:
        field.startsWith('dist-tags.') && result.versions
          ? result.versions[_.get(result, field) as unknown as string]
          : result[field],
    }),
    {} as Packument,
  )
}

/** Memoize viewMany for --deep performance. */
export const viewManyMemoized = memoize(viewMany)

/**
 * Returns the value of one of the properties retrieved by npm view.
 *
 * @param packageName   Name of the package
 * @param field         Field such as "versions" or "dist-tags.latest" are parsed from the pacote result (https://www.npmjs.com/package/pacote#packument)
 * @param currentVersion
 * @returns            Promised result
 */
export async function viewOne(
  packageName: string,
  field: string,
  currentVersion: Version,
  options: ViewOptions = {},
  npmConfigLocal?: Index<string | boolean>,
) {
  const result = await viewManyMemoized(packageName, [field], currentVersion, options, 0, npmConfigLocal)
  return result && result[field as keyof Packument]
}

/** Returns a composite predicate that filters out deprecated, prerelease, and node engine incompatibilies from version objects returns by pacote.packument. */
function filterPredicate(options: Options): (o: Packument) => boolean {
  return _.overEvery([
    o => allowDeprecatedOrIsNotDeprecated(o, options),
    o => allowPreOrIsNotPre(o, options),
    options.enginesNode ? o => satisfiesNodeEngine(o, options.nodeEngineVersion) : null!,
    options.peerDependencies ? o => satisfiesPeerDependencies(o, options.peerDependencies!) : null!,
  ])
}

/**
 * Spawn npm requires a different command on Windows.
 *
 * @param args
 * @param [npmOptions={}]
 * @param [spawnOptions={}]
 * @returns
 */
function spawnNpm(args: string | string[], npmOptions: NpmOptions = {}, spawnOptions: Index<any> = {}): Promise<any> {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  args = Array.isArray(args) ? args : [args]

  const fullArgs = args.concat(
    npmOptions.location ? `--location=${npmOptions.location}` : [],
    npmOptions.prefix ? `--prefix=${npmOptions.prefix}` : [],
    '--depth=0',
    '--json',
  )
  return spawn(cmd, fullArgs, spawnOptions)
}

/**
 * Get platform-specific default prefix to pass on to npm.
 *
 * @param options
 * @param [options.global]
 * @param [options.prefix]
 * @returns
 */
export async function defaultPrefix(options: Options): Promise<string | undefined> {
  if (options.prefix) {
    return Promise.resolve(options.prefix)
  }

  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

  let prefix

  // catch spawn error which can occur on Windows
  // https://github.com/raineorshine/npm-check-updates/issues/703
  try {
    prefix = await spawn(cmd, ['config', 'get', 'prefix'])
  } catch (e: any) {
    const message = (e.message || e || '').toString()
    print(
      options,
      'Error executing `npm config get prefix`. Caught and ignored. Unsolved: https://github.com/raineorshine/npm-check-updates/issues/703. ERROR: ' +
        message,
      'verbose',
      'error',
    )
  }

  // FIX: for ncu -g doesn't work on homebrew or windows #146
  // https://github.com/raineorshine/npm-check-updates/issues/146
  return options.global && prefix.match('Cellar')
    ? '/usr/local'
    : // Workaround: get prefix on windows for global packages
    // Only needed when using npm api directly
    process.platform === 'win32' && options.global && !process.env.prefix
    ? prefix
      ? prefix.trim()
      : `${process.env.AppData}\\npm`
    : undefined
}

/**
 * Fetches the highest version number, regardless of tag or publish time.
 *
 * @param packageName
 * @param currentVersion
 * @param options
 * @returns
 */
export const greatest: GetVersion = async (packageName, currentVersion, options = {}): Promise<string | null> => {
  // known type based on 'versions'
  const versions = (await viewOne(packageName, 'versions', currentVersion, options)) as Packument[]

  return (
    _.last(
      // eslint-disable-next-line fp/no-mutating-methods
      _.filter(versions, filterPredicate(options))
        .map(o => o.version)
        .sort(versionUtil.compareVersions),
    ) || null
  )
}

/**
 * Fetches the list of peer dependencies for a specific package version.
 *
 * @param packageName
 * @param version
 * @returns Promised {packageName: version} collection
 */
export const getPeerDependencies = async (packageName: string, version: Version): Promise<Index<Version>> => {
  const npmArgs = ['view', packageName + '@' + version, 'peerDependencies']
  const result = await spawnNpm(npmArgs, {}, { rejectOnError: false })
  return result ? parseJson(result, { command: `${npmArgs.join(' ')} --json` }) : {}
}

/**
 * Fetches the list of all installed packages.
 *
 * @param [options]
 * @param [options.cwd]
 * @param [options.global]
 * @param [options.prefix]
 * @returns
 */
export const list = async (options: Options = {}) => {
  const result = await spawnNpm(
    'ls',
    {
      ...(options.global ? { location: 'global' } : null),
      ...(options.prefix ? { prefix: options.prefix } : null),
    },
    {
      ...(options.cwd ? { cwd: options.cwd } : null),
      rejectOnError: false,
    },
  )
  const json = parseJson(result, {
    command: `npm${process.platform === 'win32' ? '.cmd' : ''} ls --json${options.global ? ' --location=global' : ''}`,
  })
  return cint.mapObject(json.dependencies, (name, info) => ({
    // unmet peer dependencies have a different structure
    [name]: info.version || (info.required && info.required.version),
  }))
}

/**
 * Fetches the version of a package published to options.distTag.
 *
 * @param packageName
 * @param currentVersion
 * @param options
 * @returns
 */
export const distTag: GetVersion = async (packageName, currentVersion, options: Options = {}) => {
  const revision = (await viewOne(packageName, `dist-tags.${options.distTag}`, currentVersion, {
    registry: options.registry,
    timeout: options.timeout,
    retry: options.retry,
  })) as unknown as Packument // known type based on dist-tags.latest

  // latest should not be deprecated
  // if latest exists and latest is not a prerelease version, return it
  // if latest exists and latest is a prerelease version and --pre is specified, return it
  // if latest exists and latest not satisfies min version of engines.node
  if (revision && filterPredicate(options)(revision)) return revision.version

  // If we use a custom dist-tag, we do not want to get other 'pre' versions, just the ones from this dist-tag
  if (options.distTag && options.distTag !== 'latest') return null

  // if latest is a prerelease version and --pre is not specified
  // or latest is deprecated
  // find the next valid version
  // known type based on dist-tags.latest
  return await greatest(packageName, currentVersion, options)
}

/**
 * Fetches the version published to the latest tag.
 *
 * @param packageName
 * @param currentVersion
 * @param options
 * @returns
 */
export const latest: GetVersion = async (packageName: string, currentVersion: Version, options: Options = {}) =>
  distTag(packageName, currentVersion, { ...options, distTag: 'latest' })

/**
 * Fetches the most recently published version, regardless of version number.
 *
 * @param packageName
 * @param currentVersion
 * @param options
 * @returns
 */
export const newest: GetVersion = async (packageName, currentVersion, options = {}): Promise<string | null> => {
  const result = await viewManyMemoized(packageName, ['time', 'versions'], currentVersion, options)

  const versionsSatisfyingNodeEngine = _.filter(result.versions, version =>
    satisfiesNodeEngine(version, options.nodeEngineVersion),
  ).map((o: Packument) => o.version)

  const versions = Object.keys(result.time || {}).reduce(
    (accum: string[], key: string) =>
      accum.concat(TIME_FIELDS.includes(key) || versionsSatisfyingNodeEngine.includes(key) ? key : []),
    [],
  )

  const versionsWithTime = _.pullAll(versions, TIME_FIELDS)

  return (
    _.last(options.pre !== false ? versions : versionsWithTime.filter(version => !versionUtil.isPre(version))) || null
  )
}

/**
 * Fetches the highest version with the same major version as currentVersion.
 *
 * @param packageName
 * @param currentVersion
 * @param options
 * @returns
 */
export const minor: GetVersion = async (packageName, currentVersion, options = {}): Promise<string | null> => {
  const versions = (await viewOne(packageName, 'versions', currentVersion, options)) as Packument[]
  return versionUtil.findGreatestByLevel(
    _.filter(versions, filterPredicate(options)).map(o => o.version),
    currentVersion,
    'minor',
  )
}

/**
 * Fetches the highest version with the same minor and major version as currentVersion.
 *
 * @param packageName
 * @param currentVersion
 * @param options
 * @returns
 */
export const patch: GetVersion = async (packageName, currentVersion, options = {}): Promise<string | null> => {
  const versions = (await viewOne(packageName, 'versions', currentVersion, options)) as Packument[]
  return versionUtil.findGreatestByLevel(
    _.filter(versions, filterPredicate(options)).map(o => o.version),
    currentVersion,
    'patch',
  )
}

export default spawnNpm
