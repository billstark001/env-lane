declare module 'picomatch' {
  export interface PicomatchOptions {
    dot?: boolean
  }

  export default function picomatch(
    patterns: string | string[],
    options?: PicomatchOptions,
  ): (input: string) => boolean
}
