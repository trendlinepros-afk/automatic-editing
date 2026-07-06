import type { ZirtolaApi } from '../shared/ipc'

declare global {
  interface Window {
    zirtola: ZirtolaApi
  }
}

export {}
