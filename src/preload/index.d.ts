import type { WickedCutApi } from '../shared/ipc'

declare global {
  interface Window {
    wickedcut: WickedCutApi
  }
}

export {}
