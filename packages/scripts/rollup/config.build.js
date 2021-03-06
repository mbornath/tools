/* eslint-env node */

const fs = require('fs-extra')
const path = require('path')

module.exports = async () => {
  const paths = require('@carv/bundle/lib/package-paths')
  const manifest = require('@carv/bundle/lib/package-manifest')
  const use = require('@carv/bundle/lib/package-use')
  const config = require('@carv/bundle/lib/config')

  await require('@carv/bundle/lib/copy-files')()

  const inputFile = require('@carv/bundle/lib/get-input-file')()

  const useTypescript = use.typescript && (inputFile.endsWith('.ts') || inputFile.endsWith('.tsx'))

  /**
   * Generate typescript definitions to .build which allows them to be picked up by svelte
   */
  const typesDirectory = path.join(paths.build, 'types')

  let dtsFile

  if (useTypescript) {
    const execa = require('execa')
    const npmRunPath = require('npm-run-path')

    console.log('Generating typescript declarations...')
    await fs.mkdirp(typesDirectory)

    const cleanupFiles = []

    try {
      if (use.svelte) {
        const svelte2tsx = require('../typescript/svelte2tsx')

        for await (const { fileName, isShim } of svelte2tsx(path.dirname(inputFile))) {
          cleanupFiles.push(fileName)

          // eslint-disable-next-line max-depth
          if (isShim) {
            // Must be available in build/types as well
            await fs.copyFile(fileName, path.join(typesDirectory, path.basename(fileName)))
          }
        }
      }

      await execa(
        'tsc',
        [
          '--emitDeclarationOnly',
          '--noEmit',
          'false',
          '--jsx',
          'preserve',
          '--project',
          paths.typescriptConfig,
          '--outDir',
          typesDirectory,
        ],
        {
          cwd: paths.root,
          env: {
            ...npmRunPath.env(),
          },
          extendEnv: true,
          stdout: 'inherit',
          stderr: 'inherit',
        },
      )

      dtsFile = await require('find-up')(path.basename(inputFile.replace(/\.(ts|tsx)$/, '.d.ts')), {
        cwd: path.resolve(typesDirectory, path.relative(paths.root, path.dirname(inputFile))),
      })
    } finally {
      await Promise.all(
        cleanupFiles.map(async (fileName) => {
          try {
            await fs.unlink(fileName)
          } catch (error) {
            console.warn(`Failed to cleanup: ${fileName}`, error)
          }
        }),
      )
    }
  }

  const outputs = require('./get-outputs')({ useTypescript })

  const publishManifest = {
    ...manifest,

    // Define package loading
    // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
    exports: {
      ...manifest.exports,
      '.': {
        node:
          outputs.node &&
          Object.fromEntries(
            Object.entries(outputs.node)
              .map(([condition, output]) => {
                return output && [condition, output.file]
              })
              .filter(Boolean),
          ),
        browser:
          outputs.browser &&
          Object.fromEntries(
            Object.entries(outputs.browser)
              .map(([condition, output]) => {
                return output && [condition, output.file]
              })
              .filter(Boolean),
          ),
        types: outputs.types?.file,
      },
      // All access to all files (including package.json, assets, chunks, ...)
      './': './',
    },

    // Used by nodejs
    main: outputs.node?.require?.file,

    // Used by carv cdn: *.svelte production transpiled
    esnext: outputs.browser?.esnext?.file,

    // Used by bundlers like rollup and cdn networks: *.svelte production transpiled
    module: outputs.browser?.import?.file,

    // Used by snowpack dev: *.svelte development transpiled
    'browser:module': outputs.browser?.development?.file,

    // Can be used from a normal script tag without module system.
    unpkg: outputs.browser?.script?.file,

    // Typying
    types: outputs.types?.file,

    // Not using it - see README
    svelte: undefined,

    // Some defaults
    sideEffects: manifest.sideEffects === true,

    // Allow publish
    private: undefined,

    // Include all files in the build folder
    files: undefined,

    // Default to cjs
    type: undefined,

    // These are not needed any more
    source: undefined,
    scripts: undefined,
    devDependencies: undefined,

    // Reset bundledDependencies as rollup includes those into the bundle
    bundledDependencies: undefined,
    bundleDependencies: undefined,

    // Reset config sections
    carv: undefined,
    eslintConfig: undefined,
    jest: undefined,
    prettier: undefined,
    snowpack: undefined,
    graphql: undefined,
  }

  await fs.writeFile(
    path.join(paths.dist, 'package.json'),
    JSON.stringify(publishManifest, null, 2),
  )

  // Bundled dependencies are included into the output bundle
  const bundledDependencies = []
    .concat(manifest.bundledDependencies || [])
    .concat(manifest.bundleDependencies || [])

  const fileNameConfig = (outputFile) => {
    const outputDirectory = path.join(paths.dist, path.dirname(outputFile))
    const base = path.relative(paths.dist, outputDirectory)

    return {
      dir: paths.dist,
      entryFileNames: path.join(base, '[name].js'),
      chunkFileNames: path.join(base, '[name]-[hash].js'),
    }
  }

  const define = require('rollup-plugin-define')
  const logStart = require('./plugin-log-start')

  function createRollupConfig(options) {
    if (!(options && options.format)) return

    const common = require('./config-common')({
      ...options,
      bundledDependencies: options.format === 'umd' || bundledDependencies,
    })

    return {
      ...common,

      perf: config.buildOptions.perf,

      input: {
        [path.basename(options.file, path.extname(options.file))]: path.relative(
          process.cwd(),
          inputFile,
        ),
      },

      output: {
        ...common.output,
        ...fileNameConfig(options.file),
        name: config.buildOptions.umdName,
        inlineDynamicImports: options.format === 'umd',
      },

      plugins: [
        logStart(options, paths.dist, use.svelte),

        ...common.plugins,

        define({
          replacements: {
            // Common
            'import.meta.browser': JSON.stringify(options.platform === 'browser'),
            'process.browser': JSON.stringify(options.platform === 'browser'),

            ...(options.platform === 'node'
              ? {
                  // Node and CJS
                  // De-alias MODE to NODE_ENV
                  'import.meta.env.MODE': 'process.env.NODE_ENV',
                  'process.env.MODE': 'process.env.NODE_ENV',

                  // Rewrite these for node.js
                  'import.meta.url': `require('url').pathToFileURL(__filename)`,
                  'import.meta.resolve': `(id, parent) => new Promise(resolve => resolve(parent ? require('module').createRequire(parent).resolve(id) : require.resolve(id)))`,

                  // Delegate to process.*
                  'import.meta.platform': 'process.platform',
                  'import.meta.env': 'process.env',

                  // No hot mode
                  'import.meta.hot': 'undefined',

                  // No other meta propeteries
                  'import.meta': '{}',
                }
              : {
                  // Browser & ESM
                  'import.meta.env.MODE': '(import.meta.env?.MODE || import.meta.env?.NODE_ENV)',
                  'process.env.MODE': '(import.meta.env?.MODE || import.meta.env?.NODE_ENV)',

                  'import.meta.platform': '"browser"',
                  'process.platform': '"browser"',

                  'process.versions.node': 'undefined',
                  'typeof process': '"undefined"',

                  ...(options.svelte.dev
                    ? {
                        // For the development builds delegate to import.meta.*
                        'process.env': '(import.meta.env || {})',
                      }
                    : {
                        // For the productions builds optimize the production code path
                        'process.env.NODE_ENV': '"production"',
                        'process.env.MODE': '"production"',
                        'process.env': '{}',

                        'import.meta.env.NODE_ENV': '"production"',
                        'import.meta.env.MODE': '"production"',
                        'import.meta.env': '{}',

                        // No hot mode
                        'import.meta.hot': 'undefined',
                      }),
                }),
          },
        }),

        // Create esm wrapper: https://nodejs.org/api/esm.html#esm_approach_1_use_an_es_module_wrapper
        options.esmWrapper && require('./plugin-esm-wrapper')(options.esmWrapper),
      ].filter(Boolean),
    }
  }

  return [
    // Generate typescript declarations
    dtsFile &&
      outputs.types && {
        input: path.relative(process.cwd(), dtsFile),

        output: {
          format: 'esm',
          file: path.join(paths.dist, outputs.types.file),
          sourcemap: true,
          preferConst: true,
          exports: 'auto',
        },

        plugins: [
          require('./plugin-assets-dts')({ inputFile, typesDirectory }),
          (0, require('rollup-plugin-dts').default)(),
        ],
      },

    ...Object.values(outputs.node || {}).map(createRollupConfig),

    ...Object.values(outputs.browser || {}).map(createRollupConfig),
  ].filter(Boolean)
}
