// Declare common modules like importing assets
import '@carv/types'

import { create } from '@carv/runtime'

import App from './app.svelte'

const app = create(App)

// Hot Module Replacement (HMR) - Remove this snippet to remove HMR.
// Learn more: https://www.snowpack.dev/#hot-module-replacement
if (import.meta.hot) {
  import.meta.hot?.accept()
  import.meta.hot?.dispose(app.$destroy)
}
