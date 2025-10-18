import type { Codecs, LoadingState, LoadOptions, ParsedTrackInfo, ZAudioEvents, ZAudioOptions } from '../types'

import { ZAudioError } from '../types'
import { useArrayBuffer } from '../utils/buffer'
import { bindEventListenerWithCleanup, clamp, formatVolume, getCodecs, sleep } from '../utils/common'
import { useStream } from '../utils/stream'

const sessionEvents = [
  'nexttrack',
  'pause',
  'play',
  'previoustrack',
  'seekbackward',
  'seekforward',
  'seekto',
  'stop',
] as const

export type HtmlEnvEventIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

export class HtmlAudioEnv<T extends ZAudioEvents = ZAudioEvents> {
  private ctx: AudioContext | undefined
  private sourceNode: MediaElementAudioSourceNode | undefined
  private gainNode: GainNode | undefined
  private nodes: AudioNode[] = []

  protected isEnding = false
  protected cleanup: VoidFunction[] = []

  protected ses: MediaSession | undefined
  protected options: Required<Omit<ZAudioOptions, 'mediaSession'>>
  private emitter: { emit: (...args: any[]) => void }

  public audio: HTMLAudioElement = new Audio()
  public state: LoadingState = 'empty'
  public codecs: Codecs

  public constructor(emitter: Mitt<T>, options: Required<Omit<ZAudioOptions, 'mediaSession'>> & { mediaSession?: boolean, codecs?: Codecs }) {
    this.emitter = emitter
    this.options = options
    this.codecs = options.codecs || getCodecs()

    this.ses = options.mediaSession ? globalThis.navigator?.mediaSession : undefined

    this.bindSession(2, () => this.play())
    this.bindSession(1, () => this.pause())
    this.bindSession(7, () => this.stop())
    this.bindSession(6, detail => detail.seekTime && this.seek(detail.seekTime))
    this.bindSession(5, detail => detail.seekOffset && this.seek(this.currentTime + detail.seekOffset))
    this.bindSession(4, detail => detail.seekOffset && this.seek(this.currentTime - detail.seekOffset))

    this.bindListener('ended', () => this.emitter.emit('ended'))
    this.bindListener('timeupdate', () => {
      this.ses?.setPositionState?.({
        duration: this.duration,
        position: this.currentTime,
        playbackRate: this.playbackRate,
      })

      this.emitter.emit('timeupdate', this.currentTime)
      if (this.fadeDuration > 0 && !this.isEnding) {
        const targetFadeDuration = (this.duration - this.currentTime) * 1e3
        if (targetFadeDuration < this.fadeDuration) {
          this.isEnding = true
          this.fade(this.gainNode!.gain.value, 0, targetFadeDuration)
        }
      }
    })
  }

  get duration(): number {
    return this.audio.duration
  }

  get isPlaying(): boolean {
    return !this.audio.paused
  }

  get currentTime(): number {
    return this.audio.currentTime
  }

  get playbackRate(): number {
    return this.audio.playbackRate
  }

  set playbackRate(rate: number) {
    if (!Number.isFinite(rate) || rate <= 0) {
      rate = 1
    }
    this.audio.playbackRate = rate
    this.emitter.emit('rate', rate)
  }

  get volume(): number {
    return this.options.volume
  }

  set volume(volume: number) {
    volume = formatVolume(volume)
    this.options.volume = volume
    this.setVolume(volume)
    this.emitter.emit('volume', volume)
  }

  get muted(): boolean {
    return this.audio.muted
  }

  set muted(muted: boolean) {
    this.options.volume = muted ? 0 : this.audio.volume
    this.audio.muted = muted
    this.emitter.emit('mute', muted)
  }

  get fadeDuration(): number {
    return this.options.fadeDuration
  }

  set fadeDuration(duration: number) {
    this.options.fadeDuration = duration
    this.emitter.emit('fadeDuration', duration)
  }

  public async load(metadata: ParsedTrackInfo, options: LoadOptions = {}): Promise<boolean> {
    const autoPlay = options.autoPlay ?? this.isPlaying
    if (this.isPlaying) {
      await this.stop()
    }

    const ext = this.extractExtension(metadata.src, options.mimeType)
    if (!ext || !this.codecs.has(ext.toLowerCase())) {
      return this.emitError(`MIMETYPE ${ext} is unsupported`)
    }

    if (!this.ctx) {
      this.ctx = this.options.getAudioContext()
      this.gainNode = this.ctx.createGain()
      this.gainNode.gain.setValueAtTime(this.volume, this.ctx.currentTime)
      this.sourceNode = this.ctx.createMediaElementSource(this.audio)
      this.gainNode.connect(this.ctx.destination)
      this.handleContext((ctx) => {
        const nodes = this.options.extraAudioNodes(ctx)
        return Array.isArray(nodes) ? nodes : nodes()
      })
      this.setVolume(this.volume)
    }
    await this.ctx.suspend()

    this.state = 'loading'
    this.isEnding = false

    let cleanupUrl: VoidFunction | undefined

    let _cleanup: VoidFunction | undefined
    const loadResult = await new Promise<boolean>((resolve) => {
      let _timeout = this.options.timeout
      const timeoutId = setTimeout(() => {
        _cleanup?.()
        resolve(this.emitError(`Loading audio ${metadata.src} timeout after ${_timeout}ms`, 2))
      }, _timeout)
      const cleanup1 = bindEventListenerWithCleanup(this.audio, 'canplay', () => resolve(true))
      const cleanup2 = bindEventListenerWithCleanup(this.audio, 'error', () => {
        this.state = 'error'
        resolve(
          this.emitError(
            this.audio.error?.message || 'Unknown audio error',
            (this.audio.error?.code || 0) as number as any,
          ),
        )
      })
      _cleanup = () => {
        cleanup1()
        cleanup2()
        clearTimeout(timeoutId)
      }

      const mimeType = options.mimeType || ''
      if (options.arrayBuffer) {
        const [src, cleanup] = useArrayBuffer(options.arrayBuffer, mimeType)
        cleanupUrl = cleanup
        this.audio.src = src
      } else if (options.stream) {
        const [src, cleanup] = useStream(options.stream as ReadableStream<Uint8Array>, mimeType, err => this.emitError(err, 5))
        cleanupUrl = cleanup
        this.audio.src = src
      } else {
        this.audio.src = metadata.src
      }
      this.audio.crossOrigin = 'anonymous'
      this.audio.load()
    }).catch(e => this.emitError(String(e), 0))
    _cleanup?.()

    if (!loadResult) {
      cleanupUrl?.()
      return false
    }
    this.emitter.emit('load', metadata)
    if (this.ses && typeof MediaMetadata !== 'undefined') {
      this.ses.metadata = new MediaMetadata(metadata)
    }
    this.state = 'loaded'

    if (options.startTime) {
      this.audio.currentTime = clamp(0, options.startTime, this.duration)
      this.emit('seek', this.audio.currentTime)
    }

    if (autoPlay) {
      const result = await this.play()
      if (!result) {
        cleanupUrl?.()
      }
      return result
    }
    return loadResult
  }

  public async play(): Promise<boolean> {
    if (this.isPlaying) {
      return true
    }
    if (!this.ctx || this.state !== 'loaded') {
      return false
    }
    try {
      if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
        await this.ctx.resume()
      }
      this.isEnding = false
      this.setVolume(0)
      if (this.ses) {
        this.ses.playbackState = 'playing'
      }
      await this.audio.play()
      this.emitter.emit('play')
      await this.fade(0, this.volume)
      return true
    } catch (e) {
      return this.emitError(`Failed to play audio, ${e}`)
    }
  }

  public async pause(): Promise<void> {
    if (!this.isPlaying) {
      return
    }
    await this.fade(this.volume, 0)
    if (this.ses) {
      this.ses.playbackState = 'paused'
    }
    await this.ctx?.suspend()
    this.audio.pause()
    this.emitter.emit('pause')
  }

  public async stop(): Promise<void> {
    await this.pause()
    this.audio.currentTime = 0
    if (this.ses) {
      this.ses.playbackState = 'none'
    }
    this.audio.src = ''
    this.audio.load()
    this.state = 'empty'
    this.emitter.emit('stop')
  }

  public async seek(time: number): Promise<void> {
    time = clamp(0, time, this.duration)
    if (!this.isPlaying) {
      this.audio.currentTime = time
      return
    }
    const vol = this.volume
    const dur = this.fadeDuration / 2
    await this.fade(vol, vol / 2, dur)
    this.audio.currentTime = time
    this.emitter.emit('seek', time)
    await this.fade(vol / 2, vol, dur)
  }

  public async fade(from: number, to: number, fadeDuration: number = this.fadeDuration): Promise<void> {
    if (fadeDuration <= 0) {
      this.setVolume(to)
      return
    }
    const currentTime = this.setVolume(formatVolume(from))
    this.gainNode?.gain.linearRampToValueAtTime(formatVolume(to), currentTime + fadeDuration / 1e3)
    await sleep(fadeDuration)
  }

  public async destroy(): Promise<void> {
    await this.pause()
    await this.ctx?.close()
    if (this.ses) {
      this.ses.playbackState = 'none'
      sessionEvents.forEach(e => this.ses!.setActionHandler(e, null))
    }
    this.cleanup.forEach(c => c())
    this.cleanup = []
    this.nodes?.forEach(n => n.disconnect())
    this.nodes = []
    // @ts-expect-error dispose
    this.audio = null
    // @ts-expect-error dispose
    this.ctx = null
    // @ts-expect-error dispose
    this.gainNode = null
  }

  public handleContext(
    fn: (
      ctx: AudioContext,
      nodes: AudioNode[],
    ) => AudioNode[] | undefined | void | null | Promise<AudioNode[] | undefined | void | null>,
  ): Promise<void> | void {
    if (!this.ctx) {
      return
    }

    const reconnectNodes = (nodes: AudioNode[] | undefined | void | null): void => {
      if (!nodes) {
        return
      }

      this.sourceNode!.disconnect()
      this.nodes.forEach(node => node.disconnect())

      if (!nodes.length) {
        this.sourceNode!.connect(this.gainNode!)
        this.nodes = []
        return
      }

      this.sourceNode!.connect(nodes[0])
      nodes.reduce((prev, curr) => (prev.connect(curr), curr))
      nodes[nodes.length - 1].connect(this.gainNode!)
      this.nodes = nodes
    }

    const result = fn(this.ctx, [...this.nodes])
    return result instanceof Promise ? result.then(reconnectNodes) : reconnectNodes(result)
  }

  private setVolume(v: number): number {
    const currentTime = this.ctx!.currentTime
    this.gainNode!.gain.cancelScheduledValues(currentTime).setValueAtTime(v, currentTime)
    return currentTime
  }

  protected emitError(msg: string, code: number = -1): false {
    this.state = 'error'
    this.emit('error', new ZAudioError(code as any, msg), code as any)
    return false
  }

  protected bindSession<T extends HtmlEnvEventIndex, _typeonly = typeof sessionEvents[T]>(eventIndex: T, handler: MediaSessionActionHandler): void {
    this.ses?.setActionHandler(sessionEvents[eventIndex], handler)
  }

  protected bindListener(event: keyof HTMLMediaElementEventMap, handler: EventListener): void {
    this.cleanup.push(bindEventListenerWithCleanup(this.audio, event, handler))
  }

  private extractExtension(src: string | undefined, mimeType?: string): string | undefined {
    const normalizedSrc = src ?? ''
    const pathMatch = normalizedSrc.split('?', 1)[0].match(/\.([^.]+)$/)?.[1]
    if (pathMatch) {
      return pathMatch.toLowerCase()
    }
    if (mimeType) {
      const type = mimeType.split('/')[1]?.split(';')[0]
      if (type) {
        return type.toLowerCase()
      }
    }
    const dataMatch = normalizedSrc.match(/^data:audio\/([^;]+);/i)?.[1]
    return dataMatch?.toLowerCase()
  }
}
