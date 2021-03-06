#!/usr/bin/env node

/* eslint-env node */
require('v8-compile-cache')

const fs = require('fs-extra')
const path = require('path')

async function main() {
  const paths = require('@carv/bundle/lib/package-paths')
  const manifest = require('@carv/bundle/lib/package-manifest')
  const use = require('@carv/bundle/lib/package-use')
  const unscopedPackageName = require('@carv/bundle/lib/unscoped-package-name')

  const inputFile = require('@carv/bundle/lib/get-input-file')()

  console.log(`Building bundle for ${path.relative(process.cwd(), inputFile)} ...`)

  await require('@carv/bundle/lib/copy-files')()

  const useTypescript = use.typescript && (inputFile.endsWith('.ts') || inputFile.endsWith('.tsx'))

  const typesDirectory = path.join(paths.build, 'types')

  let dtsFile

  if (useTypescript) {
    const execa = require('execa')
    const npmRunPath = require('npm-run-path')

    console.time(
      'Generated Typescript Declarations to ' + path.relative(process.cwd(), typesDirectory),
    )

    await fs.mkdirp(typesDirectory)

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

    const sourceDtsFile = await require('find-up')(
      path.basename(inputFile.replace(/\.(ts|tsx)$/, '.d.ts')),
      {
        cwd: path.resolve(typesDirectory, path.relative(paths.root, path.dirname(inputFile))),
      },
    )

    console.timeEnd(
      'Generated Typescript Declarations to ' + path.relative(process.cwd(), typesDirectory),
    )

    dtsFile = path.join(paths.dist, `types/${unscopedPackageName}.d.ts`)

    console.time('Bundled ' + path.relative(process.cwd(), dtsFile))

    const rollup = require('rollup')
    const bundle = await rollup.rollup({
      input: path.relative(process.cwd(), sourceDtsFile),
      plugins: [(0, require('rollup-plugin-dts').default)()],
    })

    await bundle.write({
      format: 'esm',
      file: dtsFile,
      sourcemap: true,
      preferConst: true,
      exports: 'auto',
    })

    console.timeEnd('Bundled ' + path.relative(process.cwd(), dtsFile))
  }

  const targets = {
    // Last LTS
    node: 'node10.23',
    browser: ['chrome79', 'firefox78', 'safari13.1', 'edge79'],
  }

  const outputs = {
    // Used by nodejs
    node: maybe(manifest.browser !== true, {
      outfile: `./node/${unscopedPackageName}.js`,
      platform: 'node',
      target: targets.node,
      format: 'cjs',
      mainFields: ['esnext', 'es2015', 'module', 'main'],
    }),
    // Used by carv cdn
    esnext: {
      outfile: `./esnext/${unscopedPackageName}.js`,
      // Use 'node' as platform to keep process.* like process.env.NODE_ENV around
      platform: 'node',
      target: 'esnext',
      format: 'esm',
      mainFields: ['esnext', 'es2015', 'module', 'main'],
    },
    // Used by bundlers like rollup and cdn
    module: {
      outfile: `./module/${unscopedPackageName}.js`,
      // Use 'node' as platform to keep process.* like process.env.NODE_ENV around
      platform: 'node',
      target: manifest.browser === false ? targets.node : targets.browser,
      format: 'esm',
      mainFields: ['esnext', 'es2015', 'module', 'main'],
      minify: manifest.browser !== false,
    },
    // Can be used from a normal script tag without module system.
    script: maybe(manifest.browser !== false, {
      outfile: `./script/${unscopedPackageName}.js`,
      platform: 'browser',
      target: targets.browser,
      format: 'iife',
      globalName: manifest.amdName || safeVariableName(unscopedPackageName),
      mainFields: ['esnext', 'es2015', 'module', 'browser', 'main'],
      minify: true,
    }),
  }

  const publishManifest = {
    ...manifest,

    // Define package loading
    // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
    exports: {
      ...manifest.exports,
      '.': {
        ...Object.fromEntries(
          Object.entries(outputs)
            .map(([condition, output]) => {
              return output && [condition, output.outfile]
            })
            .filter(Boolean),
        ),

        browser: maybe(manifest.browser !== false, outputs.module.outfile),

        default: outputs.node?.outfile || outputs.module.outfile,

        types: dtsFile && './' + path.relative(paths.dist, dtsFile),
      },

      // All access to all files (including package.json, assets, chunks, ...)
      './': './',
    },

    // Used by nodejs
    main: outputs.node?.outfile,

    // Used by carv cdn
    esnext: outputs.esnext?.outfile,

    // Used by bundlers like rollup and cdns
    module: outputs.module?.outfile,

    // Can be used from a normal script tag without module system.
    unpkg: outputs.script?.outfile,

    // Typying
    types: dtsFile && './' + path.relative(paths.dist, dtsFile),

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

    // Reset bundledDependencies as esbuild includes those into the bundle
    bundledDependencies: undefined,
    bundleDependencies: undefined,

    // Reset config sections
    carv: undefined,
    eslintConfig: undefined,
    jest: undefined,
    prettier: undefined,
    graphql: undefined,
    'size-limit': undefined,
    np: undefined,
  }

  await fs.writeFile(
    path.join(paths.dist, 'package.json'),
    JSON.stringify(publishManifest, null, 2),
  )

  // Bundled dependencies are included into the output bundle
  // eslint-disable-next-line unicorn/prefer-set-has
  const bundledDependencies = []
    .concat(manifest.bundledDependencies || [])
    .concat(manifest.bundleDependencies || [])

  const external = Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
    ...manifest.optinonalDependencies,
  }).filter((dependency) => !bundledDependencies.includes(dependency))

  const service = await require('esbuild').startService()

  try {
    await Promise.all(
      Object.entries(outputs)
        .filter(([_key, output]) => output)
        .map(async ([_key, output]) => {
          const outfile = path.resolve(paths.dist, output.outfile)

          const logKey = `Bundled ${path.relative(process.cwd(), outfile)} (${output.format} - ${
            output.target
          })`
          console.time(logKey)

          await service.build({
            ...output,
            outfile,
            entryPoints: [inputFile],
            charset: 'utf8',
            resolveExtensions: ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.cjs', '.css', '.json'],
            bundle: true,
            sourcemap: 'external',
            // metafile: path.resolve(paths.build, `${outfile}.meta.json`),
            external: output.format === 'iife' ? [] : external,
            define: getDefineReplacements(output),
            inject: [
              require.resolve(output.format === 'iife' ? '../shims/script.js' : '../shims/node.js'),
            ],
          })

          console.timeEnd(logKey)
        }),
    )
  } finally {
    service.stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

function maybe(condition, truthy, falsy) {
  return condition ? truthy : falsy
}

function getDefineReplacements(output) {
  if (output.platform === 'node' && output.format === 'cjs') {
    // Node & CJS
    // rewrite import.meta.* to NodeJS/CJS process.*
    return {
      // De-alias MODE to NODE_ENV
      'import.meta.env.MODE': 'process_env_NODE_ENV',
      'process.env.MODE': 'process_env_NODE_ENV',

      // Delegate to process.*
      'import.meta.platform': 'process_platform',
      'import.meta.env': 'process_env',

      // Rewrite these for node.js
      'import.meta.url': `import_meta_url`,
      'import.meta.resolve': `import_meta_resolve`,
    }
  }

  if (output.format === 'esm') {
    // Browser & ESM
    return {
      // De-alias MODE to NODE_ENV
      'import.meta.env.MODE': 'process_env_NODE_ENV',
      'process.env.MODE': 'process_env_NODE_ENV',

      // Delegate to process.*
      'import.meta.platform': 'process_platform',
      'import.meta.env': 'process_env',
    }
  }

  if (output.format === 'iife') {
    // Browser & IIFE
    return {
      // For the productions builds optimize the production code path
      'import.meta.env.NODE_ENV': '"production"',
      'import.meta.env.MODE': '"production"',

      'process.env.NODE_ENV': '"production"',
      'process.env.MODE': '"production"',

      'import.meta.platform': '"browser"',
      'process.platform': '"browser"',

      'import.meta.env': 'process_env',
      'process.env': 'process_env',

      // No hot mode
      'import.meta.hot': 'undefined',
    }
  }

  throw new Error(`Unknown format ${output.format} for platform ${output.platform}`)
}

const INVALID_ES3_IDENT = /((^[^a-zA-Z]+)|[^\w.-])|([^a-zA-Z\d]+$)/g

function safeVariableName(name) {
  const identifier = name.replace(INVALID_ES3_IDENT, '')

  return identifier.toLowerCase().replace(/[^a-zA-Z\d]+(.)/g, (m, char) => char.toUpperCase())
}
