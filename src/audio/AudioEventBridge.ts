/**
 * Maps gameplay/UI events to sounds. Player sounds are 2D (the listener sits in the player's
 * head, HRTF would only smear them); world sounds of later milestones pass `position`.
 * One PlayOptions object is reused for every call – the engine reads it synchronously.
 */
import type { PlayOptions } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { AUDIO } from '../defs/audio';
import { MOVEMENT } from '../defs/movement';
import { remapClamped } from './dsp';
import type { LoopOptions } from './AudioEngine';

/** The engine surface the bridge needs (AudioEngine implements it; tests use a fake). */
export interface AudioBridgeTarget {
  play(id: string, opts?: PlayOptions): void;
  startLoop(id: string, opts?: LoopOptions): number;
  stopLoop(handle: number, fadeSeconds?: number): void;
}

const M = AUDIO.movement;
const B = AUDIO.bridge;

export class AudioEventBridge {
  private readonly offs: (() => void)[] = [];
  private readonly opts: PlayOptions = {};
  private readonly loopOpts: LoopOptions = {};
  private slideHandle = 0;

  constructor(
    events: EventBus<GameEvents>,
    private readonly audio: AudioBridgeTarget,
  ) {
    this.offs.push(
      events.on('player:footstep', (e) => {
        const gain = e.sprinting ? M.footstepSprintGain : e.crouched ? M.footstepCrouchGain : M.footstepGain;
        this.play(B.surfaceFootsteps[e.surface] ?? B.surfaceFootsteps.default, gain, B.footstepPitchVariance);
      }),
      events.on('player:jump', (e) => {
        this.play(e.double ? 'jump.double' : 'jump', M.jumpGain, B.jumpPitchVariance);
      }),
      events.on('player:land', (e) => {
        const L = MOVEMENT.landing;
        const gain =
          M.landGain *
          remapClamped(e.impactSpeed, L.minImpactSpeed, L.heavyImpactSpeed, B.landMinImpactGain, 1);
        this.play(e.heavy ? 'land.heavy' : 'land', gain, B.landPitchVariance);
        // Surface layer so a landing on grating sounds different from one on concrete.
        this.play(
          B.surfaceFootsteps[e.surface] ?? B.surfaceFootsteps.default,
          gain * B.landSurfaceLayerGain,
          B.footstepPitchVariance,
        );
      }),
      events.on('player:slideStart', (e) => this.startSlide(e.speed)),
      events.on('player:slideEnd', () => this.stopSlide()),
      events.on('player:stateChanged', (e) => {
        // Belt and braces: never leave the slide loop running after the slide state ends.
        if (e.from === 'slide' && e.to !== 'slide') this.stopSlide();
      }),
      events.on('player:teleported', () => this.stopSlide()),
      events.on('player:dash', () => this.play('dash', M.dashGain, B.dashPitchVariance)),
      events.on('player:mantle', () => this.play('mantle', M.mantleGain, B.mantlePitchVariance)),
      events.on('player:damaged', (e) => {
        const gain = B.hurtGain * remapClamped(e.amount, 0, B.hurtFullDamage, B.hurtMinGain, 1);
        this.play('hurt', gain, B.hurtPitchVariance);
      }),
      events.on('ui:console', (e) => this.play(e.open ? 'ui.click' : 'ui.back', B.uiGain, 0, 'ui')),
      // The ui bus keeps playing while the game is paused, so the pause menu clicks too.
      events.on('ui:menu', (e) => {
        if (e.open) this.play('ui.click', B.uiGain, 0, 'ui');
        else if (!B.menuSilentClose.includes(e.menu)) this.play('ui.back', B.uiGain, 0, 'ui');
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopSlide();
  }

  private play(id: string, volume: number, pitchVariance: number, bus: PlayOptions['bus'] = 'sfx'): void {
    const o = this.opts;
    o.volume = volume;
    o.pitchVariance = pitchVariance;
    o.bus = bus;
    this.audio.play(id, o);
  }

  private startSlide(speed: number): void {
    this.stopSlide();
    const S = MOVEMENT.slide;
    const o = this.loopOpts;
    o.volume = M.slideGain * remapClamped(speed, S.minStartSpeed, S.maxSpeed, B.slideMinSpeedGain, 1);
    o.bus = 'sfx';
    o.fadeIn = B.slideFadeIn;
    o.maxDuration = B.slideMaxSeconds;
    this.slideHandle = this.audio.startLoop('slide', o);
  }

  private stopSlide(): void {
    if (this.slideHandle === 0) return;
    this.audio.stopLoop(this.slideHandle, B.slideFadeOut);
    this.slideHandle = 0;
  }
}
