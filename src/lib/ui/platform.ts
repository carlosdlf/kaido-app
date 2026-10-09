/** Whether the app runs on macOS, where shortcuts use Cmd instead of Ctrl. */
export function isMac(userAgent: string = globalThis.navigator?.userAgent ?? ""): boolean {
  return /Macintosh|Mac OS X/.test(userAgent);
}
