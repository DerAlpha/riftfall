import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GRAPHICS_PRESETS } from '../../defs/graphics';
import { POSTFX } from '../../defs/postfx';
import { createDefaultSettings, type GraphicsSettings } from '../../save/settingsSchema';
import { PostFXPipeline, type PostFXFrameState } from './PostFXPipeline';

/** Just enough of a WebGLRenderer for the composer to build its passes (no GL in tests). */
function fakeRenderer(): THREE.WebGLRenderer {
  return {
    extensions: { has: () => true },
    outputColorSpace: THREE.SRGBColorSpace,
    autoClear: true,
    getSize: (v: THREE.Vector2) => v.set(64, 36),
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 36),
    getPixelRatio: () => 1,
    getContext: () => ({ getContextAttributes: () => ({ alpha: false }) }),
  } as unknown as THREE.WebGLRenderer;
}

function graphics(patch: Partial<GraphicsSettings>): GraphicsSettings {
  // AO off: N8AO needs a real context.
  return { ...createDefaultSettings().graphics, ...GRAPHICS_PRESETS.low, ambientOcclusion: 'off', ...patch };
}

function frame(patch: Partial<PostFXFrameState> = {}): PostFXFrameState {
  return {
    dt: 1 / 60,
    simDt: 1 / 60,
    adsAmount: 0,
    focusDistance: POSTFX.depthOfField.defaultFocusDistance,
    caPulse: 0,
    hitFlash: 0,
    lowHealth: 0,
    heartbeat: 0,
    ...patch,
  };
}

function setup(g: Partial<GraphicsSettings>): {
  post: PostFXPipeline;
  /** Pass names as the composer saw them in the last render (disabled ones in parentheses). */
  rendered: () => string[];
  dispose(): void;
} {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 500);
  camera.updateMatrixWorld();
  const post = new PostFXPipeline(
    fakeRenderer(),
    new THREE.Scene(),
    camera,
    new THREE.Scene(),
    new THREE.PerspectiveCamera(),
  );
  post.applyGraphics(graphics(g));
  let last: string[] = [];
  // The GL work itself is out of reach here; record which passes would run.
  post.composer.render = () => {
    last = post.info.passes;
  };
  return { post, rendered: () => last, dispose: () => post.dispose() };
}

describe('PostFXPipeline', () => {
  it('runs the volumetric pass with level volumetrics off only while VFX content is live', () => {
    const { post, rendered, dispose } = setup({ volumetrics: 'off' });
    // No probe (content unknown): keep drawing.
    post.render(frame());
    expect(rendered()).toContain('Volumetrics');

    let live = false;
    post.setVolumetricContentProbe(() => live);
    post.render(frame());
    expect(rendered()).toContain('(Volumetrics)');
    live = true;
    post.render(frame());
    expect(rendered()).toContain('Volumetrics');

    // The warm-up frame compiles everything, whatever the probe says.
    live = false;
    post.render(frame());
    post.warmup();
    expect(rendered()).toContain('Volumetrics');
    expect(post.info.passes).toContain('(Volumetrics)');
    dispose();
  });

  it('always runs the volumetric pass while level volumetrics are on', () => {
    const { post, rendered, dispose } = setup({ volumetrics: 'low' });
    post.setVolumetricContentProbe(() => false);
    post.render(frame());
    expect(rendered()).toContain('Volumetrics');
    dispose();
  });

  it('ages shockwaves on game time: frozen while paused (simDt 0), done after their duration', () => {
    const { post, rendered, dispose } = setup({ volumetrics: 'off' });
    post.render(frame());
    expect(rendered()).toContain('(Shockwave)');

    post.addShockwave({ x: 0, y: 0, z: -5 }, 4, 1);
    // Paused: real frames keep coming, game time stands still.
    for (let i = 0; i < 120; i++) post.render(frame({ dt: 0.1, simDt: 0 }));
    expect(rendered()).toContain('Shockwave');

    // Slow motion: a real second at timeScale 0.1 is not enough.
    for (let i = 0; i < 60; i++) post.render(frame({ dt: 1 / 60, simDt: 0.1 / 60 }));
    expect(rendered()).toContain('Shockwave');

    post.render(frame({ simDt: POSTFX.shockwave.duration }));
    expect(rendered()).toContain('(Shockwave)');
    dispose();
  });
});
