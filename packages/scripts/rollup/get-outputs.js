/* eslint-env node */

// eslint-disable-next-line func-names
module.exports = function getOutputs({
  useTypescript = require('@carv/bundle/lib/package-use').typescript,
  mode = require('@carv/bundle/lib/config').buildOptions.mode,
} = {}) {
  const manifest = require('@carv/bundle/lib/package-manifest')
  const unscopedPackageName = require('@carv/bundle/lib/unscoped-package-name')

  return {
    node: maybe(manifest.browser !== true, {
      require: {
        platform: 'node',
        target: 'es2019',
        format: 'cjs',
        mainFields: ['main'],
        svelte: { dev: true, generate: 'dom' },
        file: `./node/cjs/${unscopedPackageName}.js`,
        esmWrapper: `./node/esm/${unscopedPackageName}.js`,
      },

      default: {
        // This is created by the esmWrapper above
        file: `./node/esm/${unscopedPackageName}.js`,
      },
    }),

    browser: maybe(manifest.browser !== false, {
      development: {
        platform: 'browser',
        target: 'es2020',
        format: 'esm',
        mainFields: ['browser:module', 'esnext', 'es2015'],
        svelte: { dev: true, generate: 'dom' },
        file: `./browser/dev/${unscopedPackageName}.js`,
      },

      import: {
        platform: 'browser',
        target: 'es2015',
        format: 'esm',
        mainFields: ['esnext', 'es2015'],
        svelte: { dev: false, generate: 'dom' },
        file: `./browser/import/${unscopedPackageName}.js`,
      },

      esnext: maybe(mode === 'library', {
        platform: 'browser',
        target: 'esnext',
        format: 'esm',
        mainFields: ['esnext', 'es2015'],
        svelte: { dev: false, generate: 'dom' },
        file: `./browser/esnext/${unscopedPackageName}.js`,
      }),

      script: maybe(mode === 'app', {
        platform: 'browser',
        target: 'es2015',
        format: 'umd',
        mainFields: ['esnext', 'es2015'],
        svelte: { dev: false, generate: 'dom' },
        file: `./${unscopedPackageName}.js`,
      }),
    }),

    types: maybe(useTypescript, {
      format: 'typescript',
      file: `./types/${unscopedPackageName}.d.ts`,
    }),
  }
}

function maybe(condition, truthy, falsy) {
  return condition ? truthy : falsy
}
