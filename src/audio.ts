import type {
  Codecs,
  LoadingState,
  LoadOptions,
  ParsedTrackInfo,
  ZAudioErrorCode,
  ZAudioEvents,
  ZAudioOptions,
} from './types'
import type { Promisable } from '@subframe7536/type-utils'

import { Mitt } from 'zen-mitt/class'

import { ZAudioError } from './types'
import { clamp, formatVolume, getCodecs, sleep } from './utils/common'

// Keep order
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

type EventIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

/**
 * Audio player class with fade effects and media session support built on top of AudioContext
 */
export class ZAudio<T extends ZAudioEvents = ZAudioEvents> extends Mitt<T> {
  private ctx: AudioContext | undefined
  private gainNode: GainNode | undefined
  private buffer: AudioBuffer | undefined
  private sourceNode: AudioBufferSourceNode | undefined
  private nodes: AudioNode[] = []
  private startTimestamp: number | undefined
  private offset = 0
  private timeUpdateTimer: ReturnType<typeof setInterval> | null = null
  private _playbackRate = 1
  private _muted = false

  protected options: Required<Omit<ZAudioOptions, 'mediaSession'>>
  protected isEnding = false
  protected ses: MediaSession | undefined

  /**
   * @deprecated HTMLAudioElement is no longer used internally. This property will remain `undefined`.
   */
  public audio: HTMLAudioElement | undefined

  public codecs: Codecs
  public state: LoadingState = 'empty'

  public constructor(options: ZAudioOptions = {}) {
    super()
    this.codecs = getCodecs()
    this.options = {
      fadeDuration: 500,
      volume: 0.5,
      timeout: 10000,
      getAudioContext: () => {
        const AudioContextCtor = globalThis.AudioContext || (globalThis as any).webkitAudioContext
        if (!AudioContextCtor) {
          throw new Error('AudioContext is not available in this environment')
        }
        return new AudioContextCtor()
      },
      extraAudioNodes: () => [],
      ...options,
    }

    this.audio = undefined

    this.ses = options.mediaSession ? globalThis.navigator?.mediaSession : undefined

    this.bindSession(2, () => this.play())
    this.bindSession(1, () => this.pause())
    this.bindSession(7, () => this.stop())
    this.bindSession(6, detail => detail.seekTime != null && this.seek(detail.seekTime))
    this.bindSession(5, detail => detail.seekOffset != null && this.seek(this.currentTime + detail.seekOffset))
    this.bindSession(4, detail => detail.seekOffset != null && this.seek(this.currentTime - detail.seekOffset))
  }

  /**
   * Return the duration in seconds of the current media resource.
   * A NaN value is returned if duration is not available,
   * or Infinity if the media resource is streaming.
   */
  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  /**
   * Get a flag that specifies whether playback is playing.
   */
  get isPlaying(): boolean {
    return !!this.sourceNode
  }

  /**
   * Get the current playback position, in seconds.
   */
  get currentTime(): number {
    return this.computeCurrentTime()
  }

  /**
   * Get the current rate of speed for the media resource to play.
   * This speed is expressed as a multiple of the normal speed of the media resource.
   */
  get playbackRate(): number {
    return this._playbackRate
  }

  /**
   * Set the current rate of speed for the media resource to play.
   * This speed is expressed as a multiple of the normal speed of the media resource.
   *
   * Emit "rate" event
   */
  set playbackRate(rate: number) {
    if (!Number.isFinite(rate) || rate <= 0) {
      rate = 1
    }

    if (rate === this._playbackRate) {
      return
    }

    const ctx = this.ctx
    if (ctx && this.sourceNode && this.startTimestamp !== undefined) {
      const currentPosition = this.computeCurrentTime(ctx.currentTime)
      this.offset = clamp(0, currentPosition, this.duration)
      this.startTimestamp = ctx.currentTime
    }

    this._playbackRate = rate

    if (ctx && this.sourceNode) {
      this.sourceNode.playbackRate.setValueAtTime(rate, ctx.currentTime)
    }

    this.emit('rate', rate)
  }

  /**
   * Get the current volume for the media resource to play.
   * The value is between 0 and 1.
   */
  get volume(): number {
    return this.options.volume
  }

  /**
   * Set the current volume for the media resource to play.
   * The value is between 0 and 1.
   *
   * Emit "volume" event
   */
  set volume(volume: number) {
    volume = formatVolume(volume)
    this.options.volume = volume
    if (!this._muted) {
      this.setVolume(volume)
    }
    this.emit('volume', volume)
  }

  /**
   * Get a flag that indicates whether the audio is muted.
   */
  get muted(): boolean {
    return this._muted
  }

  /**
   * Set a flag that indicates whether the audio is muted.
   *
   * Emit "muted" event
   */
  set muted(muted: boolean) {
    if (this._muted === muted) {
      return
    }
    this._muted = muted
    this.setVolume(muted ? 0 : this.options.volume)
    this.emit('mute', muted)
  }

  /**
   * Get the fade duration.
   */
  get fadeDuration(): number {
    return this.options.fadeDuration
  }

  /**
   * Set the fade duration.
   */
  set fadeDuration(duration: number) {
    this.options.fadeDuration = duration
    this.emit('fadeDuration', duration)
  }

  protected emitError(msg: string, code: ZAudioErrorCode = -1): false {
    this.state = 'error'
    this.stopTimeUpdates()
    this.emit('error', new ZAudioError(code, msg), code)
    return false
  }

  protected bindSession<T extends EventIndex, _typeonly = typeof sessionEvents[T]>(
    eventIndex: T,
    handler: MediaSessionActionHandler,
  ): void {
    this.ses?.setActionHandler(sessionEvents[eventIndex], handler)
  }

  /**
   * Handle audio context and nodes. If return value is audio nodes, reconnect them to destination
   *
   * Do nothing if AudioContext is not created
   * @param fn Function to handle audio context and nodes
   */
  public handleContext(
    fn: (
      ctx: AudioContext,
      nodes: AudioNode[],
    ) => Promisable<AudioNode[] | undefined | void | null>,
  ): Promisable<void> {
    if (!this.ctx || !this.gainNode) {
      return
    }

    const result = fn(this.ctx, [...this.nodes])
    const apply = (nodes?: AudioNode[] | null | void): void => {
      if (nodes == null) {
        return
      }
      this.setNodes(nodes)
    }

    return result instanceof Promise ? result.then(apply) : apply(result)
  }

  /**
   * Load audio, auto play if isPlaying, audio is not loaded when the return value is `false`
   * @param metadata track info
   * @param options load options
   */
  public async load(metadata: ParsedTrackInfo, options: LoadOptions = {}): Promise<boolean> {
    const autoPlay = options.autoPlay ?? this.isPlaying

    if (this.isPlaying) {
      await this.stop()
    } else {
      this.stopSource()
      this.stopTimeUpdates()
    }

    let ctx: AudioContext
    try {
      ctx = this.ensureContext()
    } catch (error) {
      return this.emitError(
        error instanceof Error ? error.message : String(error),
      )
    }

    this.state = 'loading'
    this.isEnding = false
    this.buffer = undefined

    const ext = this.extractExtension(metadata.src, options.mimeType)
    if (ext && !this.codecs.has(ext.toLowerCase())) {
      return this.emitError(`MIMETYPE ${ext} is unsupported`)
    }

    const shouldCloneBuffer = Boolean(options.arrayBuffer)
    let arrayBuffer: ArrayBuffer
    try {
      arrayBuffer = await this.resolveArrayBuffer(metadata, options)
    } catch (error) {
      if (error instanceof ZAudioError) {
        return this.emitError(error.message, error.code)
      }
      const err = error as Error
      if ((err as DOMException)?.name === 'AbortError') {
        return this.emitError(
          `Loading audio ${metadata.src ?? '[stream]'} timeout after ${this.options.timeout}ms`,
          2,
        )
      }
      return this.emitError(err.message || 'Unknown audio error', 0)
    }

    try {
      const decoded = await ctx.decodeAudioData(shouldCloneBuffer ? arrayBuffer.slice(0) : arrayBuffer)
      this.buffer = decoded
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.emitError(`Failed to decode audio data, ${message}`, 0)
    }

    const startOffset = clamp(0, options.startTime ?? 0, this.duration)
    this.offset = startOffset
    this.startTimestamp = undefined
    this.state = 'loaded'
    this.isEnding = false
    this.setVolume(this._muted ? 0 : this.options.volume)
    this.updateSessionMetadata(metadata)
    this.emit('load', metadata)
    this.emitTimeUpdate(this.offset)

    if (autoPlay) {
      return await this.play()
    }
    return true
  }

  /**
   * Play audio, audio will not play when the return value is `false`
   */
  public async play(): Promise<boolean> {
    if (this.isPlaying) {
      return true
    }

    if (!this.ctx || !this.buffer || this.state !== 'loaded') {
      return false
    }

    try {
      if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
        await this.ctx.resume()
      }

      this.isEnding = false
      this.setVolume(0)
      this.startSource(this.offset)
      if (this.ses) {
        this.ses.playbackState = 'playing'
      }
      this.emit('play')
      await this.fade(0, this._muted ? 0 : this.options.volume)
      return true
    } catch (error) {
      this.stopSource()
      return this.emitError(`Failed to play audio, ${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Pause audio
   */
  public async pause(): Promise<void> {
    if (!this.isPlaying) {
      return
    }

    const currentGain = this.getCurrentGain()
    await this.fade(currentGain, 0)
    const position = this.computeCurrentTime()
    this.stopSource()
    this.offset = clamp(0, position, this.duration)
    this.stopTimeUpdates()
    this.isEnding = false
    if (this.ses) {
      this.ses.playbackState = 'paused'
    }
    this.emitTimeUpdate(this.offset)
    this.emit('pause')
  }

  /**
   * Stop audio
   */
  public async stop(): Promise<void> {
    await this.pause()
    this.offset = 0
    this.buffer = undefined
    this.state = 'empty'
    this.isEnding = false
    if (this.ses) {
      this.ses.playbackState = 'none'
    }
    this.emitTimeUpdate(0)
    this.emit('stop')
  }

  /**
   * Seek audio to specific time
   */
  public async seek(time: number): Promise<void> {
    if (!this.buffer) {
      return
    }

    const target = clamp(0, time, this.duration)
    this.isEnding = false

    if (!this.isPlaying) {
      this.offset = target
      this.emitTimeUpdate(this.offset)
      return
    }

    const currentGain = this.getCurrentGain()
    const fadeHalfDuration = this.fadeDuration / 2
    const midGain = currentGain / 2

    await this.fade(currentGain, midGain, fadeHalfDuration)
    this.stopSource()
    this.offset = target
    this.emit('seek', target)
    this.emitTimeUpdate(this.offset)
    this.startSource(this.offset)
    await this.fade(midGain, this._muted ? 0 : this.options.volume, fadeHalfDuration)
  }

  /**
   * Fade audio's volume
   */
  public async fade(
    from: number,
    to: number,
    fadeDuration: number = this.fadeDuration,
  ): Promise<void> {
    if (!this.ctx || !this.gainNode) {
      return
    }

    fadeDuration = Math.max(0, fadeDuration)

    if (fadeDuration <= 0) {
      this.setVolume(formatVolume(to))
      return
    }

    const currentTime = this.setVolume(formatVolume(from))
    this.gainNode.gain.linearRampToValueAtTime(
      formatVolume(to),
      currentTime + fadeDuration / 1e3,
    )
    await sleep(fadeDuration)
  }

  /**
   * Destroy instance
   */
  public async destroy(): Promise<void> {
    await this.pause()
    this.stopSource()
    this.stopTimeUpdates()
    await this.ctx?.close()

    const ses = this.ses
    if (ses) {
      ses.playbackState = 'none'
      sessionEvents.forEach(event => ses.setActionHandler(event, null))
    }

    this.nodes.forEach(node => node.disconnect())
    this.nodes = []
    this.buffer = undefined
    this.gainNode?.disconnect()
    this.gainNode = undefined
    this.ctx = undefined
    this.offset = 0
    this.startTimestamp = undefined
    this.audio = undefined
    this.state = 'empty'
    this.off()
  }

  private ensureContext(): AudioContext {
    if (this.ctx) {
      return this.ctx
    }

    const ctx = this.options.getAudioContext()
    this.ctx = ctx
    this.gainNode = ctx.createGain()
    this.gainNode.connect(ctx.destination)

    const extra = this.options.extraAudioNodes(ctx)
    if (Array.isArray(extra)) {
      this.setNodes(extra)
    } else {
      this.setNodes(extra?.())
    }

    this.setVolume(this._muted ? 0 : this.options.volume)
    return ctx
  }

  private setVolume(value: number): number {
    if (!this.ctx || !this.gainNode) {
      return 0
    }
    const currentTime = this.ctx.currentTime
    this.gainNode.gain.cancelScheduledValues(currentTime)
    this.gainNode.gain.setValueAtTime(formatVolume(value), currentTime)
    return currentTime
  }

  private getCurrentGain(): number {
    if (this.gainNode) {
      return this.gainNode.gain.value
    }
    return this._muted ? 0 : this.options.volume
  }

  private computeCurrentTime(referenceTime: number = this.ctx?.currentTime ?? 0): number {
    const duration = this.duration
    if (!this.buffer || duration <= 0) {
      return 0
    }

    if (!this.sourceNode || this.startTimestamp === undefined) {
      return clamp(0, this.offset, duration)
    }

    const elapsed = (referenceTime - this.startTimestamp) * this._playbackRate
    return clamp(0, this.offset + elapsed, duration)
  }

  private startSource(offset: number): void {
    if (!this.ctx || !this.buffer || !this.gainNode) {
      throw new Error('Audio buffer is not loaded')
    }

    const maxOffset = this.duration > 0 ? Math.max(this.duration - 1e-6, 0) : 0
    const startOffset = clamp(0, offset, maxOffset)

    this.stopSource()

    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.playbackRate.setValueAtTime(this._playbackRate, this.ctx.currentTime)
    source.onended = () => this.handleSourceEnded(source)

    this.connectSourceNode(source)
    source.start(0, startOffset)

    this.sourceNode = source
    this.offset = startOffset
    this.startTimestamp = this.ctx.currentTime
    this.startTimeUpdates()
  }

  private stopSource(): void {
    if (!this.sourceNode) {
      return
    }

    const source = this.sourceNode
    source.onended = null
    try {
      source.stop()
    } catch {
      // ignore stop errors on already stopped sources
    }
    source.disconnect()
    if (this.sourceNode === source) {
      this.sourceNode = undefined
    }
    this.startTimestamp = undefined
  }

  private handleSourceEnded(source: AudioBufferSourceNode): void {
    if (this.sourceNode === source) {
      this.sourceNode = undefined
    }
    this.startTimestamp = undefined
    this.offset = this.duration
    this.stopTimeUpdates()
    this.isEnding = false
    if (this.ses) {
      this.ses.playbackState = 'none'
    }
    this.emitTimeUpdate(this.offset)
    this.emit('ended')
  }

  private connectSourceNode(source: AudioNode): void {
    if (!this.gainNode) {
      return
    }

    if (!this.nodes.length) {
      source.connect(this.gainNode)
      return
    }

    source.connect(this.nodes[0])
  }

  private setNodes(nodes: AudioNode[] | undefined | null): void {
    if (!this.gainNode) {
      this.nodes = []
      return
    }

    this.nodes.forEach(node => node.disconnect())
    if (!nodes || !nodes.length) {
      this.nodes = []
      if (this.sourceNode) {
        this.sourceNode.disconnect()
        this.sourceNode.connect(this.gainNode)
      }
      return
    }

    nodes.forEach(node => node.disconnect())
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].connect(nodes[i + 1])
    }
    nodes[nodes.length - 1].connect(this.gainNode)
    this.nodes = [...nodes]

    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.connectSourceNode(this.sourceNode)
    }
  }

  private startTimeUpdates(): void {
    this.stopTimeUpdates()
    this.handleTimeUpdate()
    this.timeUpdateTimer = setInterval(() => this.handleTimeUpdate(), 200)
  }

  private stopTimeUpdates(): void {
    if (this.timeUpdateTimer !== null) {
      clearInterval(this.timeUpdateTimer)
      this.timeUpdateTimer = null
    }
  }

  private handleTimeUpdate(): void {
    if (!this.buffer) {
      return
    }
    const position = this.computeCurrentTime()
    this.emitTimeUpdate(position)

    if (this.fadeDuration > 0 && !this.isEnding) {
      const remaining = (this.duration - position) * 1e3
      if (remaining > 0 && remaining < this.fadeDuration) {
        this.isEnding = true
        void this.fade(this.getCurrentGain(), 0, remaining)
      }
    }
  }

  private emitTimeUpdate(position: number): void {
    this.updateSessionPosition(position)
    this.emit('timeupdate', position)
  }

  private updateSessionPosition(position: number): void {
    if (!this.ses?.setPositionState) {
      return
    }
    this.ses.setPositionState({
      duration: this.duration,
      position,
      playbackRate: this._playbackRate,
    })
  }

  private updateSessionMetadata(metadata: ParsedTrackInfo): void {
    if (!this.ses || typeof MediaMetadata === 'undefined') {
      return
    }
    this.ses.metadata = new MediaMetadata(metadata)
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

  private async resolveArrayBuffer(metadata: ParsedTrackInfo, options: LoadOptions): Promise<ArrayBuffer> {
    if (options.arrayBuffer) {
      return options.arrayBuffer
    }
    if (options.stream) {
      try {
        return await new Response(options.stream).arrayBuffer()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new ZAudioError(5, `Stream error: ${message}`)
      }
    }

    if (!metadata.src) {
      throw new TypeError('No audio source provided')
    }

    if (typeof fetch !== 'function') {
      throw new ReferenceError('Global fetch is not available in this environment')
    }

    const timeout = this.options.timeout
    const controller = timeout > 0 && typeof AbortController !== 'undefined'
      ? new AbortController()
      : undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    if (controller) {
      timer = setTimeout(() => controller.abort(), timeout)
    }

    try {
      const response = await fetch(metadata.src, controller ? { signal: controller.signal } : undefined)
      if (!response.ok) {
        throw new Error(`Failed to load audio ${metadata.src}, status ${response.status}`)
      }
      return await response.arrayBuffer()
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }
}
