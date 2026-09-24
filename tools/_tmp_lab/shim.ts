// Temporary harness shim: Game.ts imports buildTestRoom from here instead (vite alias).
export { buildResearchLab as buildTestRoom } from '../../src/maps/lab/ResearchLab';
export * from '../../src/world/TestRoom';
