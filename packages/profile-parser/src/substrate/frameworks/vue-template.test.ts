import { describe, expect, it } from 'vitest';
import { vueTemplateTags } from './vue-template.js';

describe('vueTemplateTags — Vue built-in filtering', () => {
  it('drops Vue built-ins in both spellings but keeps real components', () => {
    const sfc = `<template>
  <Teleport to="body">
    <transition-group name="list">
      <UserCard />
      <keep-alive><Suspense><user-row /></Suspense></keep-alive>
    </transition-group>
  </Teleport>
</template>
`;
    const tags = vueTemplateTags(sfc, new Set(['UserRow', 'KeepAlive', 'TransitionGroup']));
    expect(tags.map((t) => t.name).sort()).toEqual(['UserCard', 'UserRow']);
  });
});
